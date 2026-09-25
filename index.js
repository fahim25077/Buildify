const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// ============================================================
// Firebase Admin credentials
// Priority:
// 1) FIREBASE_SERVICE_ACCOUNT_JSON environment variable
// 2) SERVICE_ACCOUNT_JSON environment variable
// 3) Render Secret File: /etc/secrets/serviceAccountKey.json
// 4) Local file: ./serviceAccountKey.json (for local testing)
// ============================================================

function parseServiceAccount(raw, source) {
  if (!raw || !String(raw).trim()) {
    throw new Error(`Firebase service account is empty (${source})`);
  }

  const text = String(raw).replace(/^\uFEFF/, '').trim();

  // Normal JSON value
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Invalid Firebase service account JSON in ${source}: ${e.message}`);
    }
  }

  // Optional base64 support.
  // This is useful when multiline/private-key formatting is inconvenient.
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) {
      return JSON.parse(decoded);
    }
  } catch (_) {}

  throw new Error(`Firebase service account in ${source} is not valid JSON`);
}

function loadServiceAccount() {
  const envCandidates = [
    ['FIREBASE_SERVICE_ACCOUNT_JSON', process.env.FIREBASE_SERVICE_ACCOUNT_JSON],
    ['SERVICE_ACCOUNT_JSON', process.env.SERVICE_ACCOUNT_JSON],
    ['service account JSON', process.env['service account JSON']]
  ];

  for (const [name, value] of envCandidates) {
    if (value && String(value).trim()) {
      return parseServiceAccount(value, `environment variable ${name}`);
    }
  }

  const secretFile = '/etc/secrets/serviceAccountKey.json';
  if (fs.existsSync(secretFile)) {
    return parseServiceAccount(fs.readFileSync(secretFile, 'utf8'), secretFile);
  }

  const localFile = './serviceAccountKey.json';
  if (fs.existsSync(localFile)) {
    return parseServiceAccount(fs.readFileSync(localFile, 'utf8'), localFile);
  }

  throw new Error(
    'Firebase credentials not found. Set FIREBASE_SERVICE_ACCOUNT_JSON in Render, '
    + 'or add a Render Secret File named serviceAccountKey.json.'
  );
}

let serviceAccount;
try {
  serviceAccount = loadServiceAccount();

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Firebase service account is missing project_id, client_email, or private_key');
  }

  // Some copied credentials can contain literal "\\n" inside private_key.
  serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log(`Firebase Admin initialized for project: ${serviceAccount.project_id}`);
} catch (e) {
  console.error('Firebase initialization failed:', e.message);
  process.exit(1);
}

const db = admin.firestore();

// ============================================================
// HELPERS
// ============================================================

function isValidAppId(appId) {
  return appId && /^[a-zA-Z0-9._\-]{3,100}$/.test(appId);
}

function tokenDocId(token) {
  return token.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
}

function devicesRef(appId) {
  return db.collection('push_tokens').doc(appId).collection('devices');
}

function appMetaRef(appId) {
  return db.collection('push_app_meta').doc(appId);
}

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.send('Wevlo Push Notification Server is Running!');
});

// GET /debug
app.get('/debug', (req, res) => {
  res.json({
    project_id: serviceAccount.project_id,
    client_email: serviceAccount.client_email,
    private_key_id: serviceAccount.private_key_id,
    private_key_len: (serviceAccount.private_key || '').length
  });
});

// GET /app-status?appId=com.myapp.xyz
app.get('/app-status', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const metaDoc = await appMetaRef(appId).get();
    const tokenSnap = await devicesRef(appId).get();
    res.json({
      success: true,
      appId,
      registered: metaDoc.exists,
      registeredAt: metaDoc.exists ? metaDoc.data().registeredAt : null,
      tokenCount: tokenSnap.size
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /register-app  { appId, password }
app.post('/register-app', async (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const ref = appMetaRef(appId);
    const doc = await ref.get();

    await ref.set({
      appId,
      registeredAt: doc.exists ? doc.data().registeredAt : Date.now(),
      updatedAt: Date.now()
    }, { merge: true });

    console.log(`[${appId}] App registered/updated`);
    res.json({ success: true, message: 'app registered' });
  } catch (e) {
    console.error('Register-app error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /register-token  { token, appId, userAgent?, password? }
app.post('/register-token', async (req, res) => {
  const { token, appId, userAgent } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, error: 'token required' });
  }
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    await devicesRef(appId).doc(tokenDocId(token)).set({
      token,
      appId,
      userAgent: userAgent || '',
      registeredAt: Date.now(),
      updatedAt: Date.now()
    }, { merge: true });

    console.log(`[${appId}] Token registered: ${token.substring(0, 20)}...`);
    res.json({ success: true });
  } catch (e) {
    console.error('Register error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /tokens?appId=com.myapp.xyz&password=xxx
app.get('/tokens', async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const snap = await devicesRef(appId).get();
    const tokens = snap.docs.map(d => ({
      token: d.data().token,
      registeredAt: d.data().registeredAt,
      userAgent: d.data().userAgent || ''
    }));
    res.json({ success: true, appId, count: tokens.length, tokens });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /send-notification  { token, title, body, password, appId }
app.post('/send-notification', async (req, res) => {
  const { token, title, body, imageUrl } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: 'token required' });
  }

  try {
    const t = title || 'Notification';
    const b = body || '';

    const message = {
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    };

    const msgId = await admin.messaging().send(message);
    res.json({ success: true, messageId: msgId });
  } catch (e) {
    console.error('Send error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /send-all  { appId, title, body, password }
app.post('/send-all', async (req, res) => {
  const { appId, title, body, imageUrl } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const snap = await devicesRef(appId).get();
    if (snap.empty) {
      return res.json({ success: false, error: 'No tokens found for this app' });
    }

    const tokens = snap.docs.map(d => d.data().token).filter(Boolean);
    const t = title || 'Notification';
    const b = body || '';
    const messages = tokens.map(token => ({
      token,
      data: { title: t, body: b, ...(imageUrl ? { imageUrl } : {}) },
      android: { priority: 'high' }
    }));

    const result = await admin.messaging().sendEach(messages);
    console.log(`[${appId}] Sent: ${result.successCount} ok, ${result.failureCount} failed`);

    const batch = db.batch();
    let removed = 0;
    result.responses.forEach((r, i) => {
      if (!r.success) {
        batch.delete(snap.docs[i].ref);
        removed++;
      }
    });
    if (removed > 0) await batch.commit();

    res.json({
      success: true,
      appId,
      total: tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount
    });
  } catch (e) {
    console.error('Send-all error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /token?appId=com.myapp&token=xxx&password=yyy
app.delete('/token', async (req, res) => {
  const { appId, token } = req.query;
  if (!isValidAppId(appId) || !token) {
    return res.status(400).json({ success: false, error: 'appId and token required' });
  }

  try {
    await devicesRef(appId).doc(tokenDocId(token)).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Wevlo Push Server running on port ${PORT}`);
});
