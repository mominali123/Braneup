// lib/verifyAuth.js
import admin from 'firebase-admin';

const PROJECT_ID = 'braneupbusinessconsultancy'; // must match the web app's projectId

function getAdmin() {
  if (!admin.apps.length) {
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '')
      .replace(/^"|"$/g, '')       // strip accidental wrapping quotes
      .replace(/\\n/g, '\n');      // turn literal \n into real newlines

    if (!clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) {
      throw Object.assign(new Error('Firebase service account env vars missing or malformed'), { code: 'config/bad-env' });
    }
    admin.initializeApp({
      credential: admin.credential.cert({ projectId: PROJECT_ID, clientEmail, privateKey }),
    });
  }
  return admin;
}

// Returns { user } on success, or { status, body } to send back on failure.
export async function verifyAuth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token === 'undefined') {
    console.error('AUTH: no bearer token');
    return { status: 401, body: { error: 'Please sign in again.', code: 'auth/no-token' } };
  }
  try {
    const user = await getAdmin().auth().verifyIdToken(token);
    return { user };
  } catch (e) {
    console.error('AUTH FAILED:', e.code, '|', e.message);
    if (e.code === 'config/bad-env') {
      return { status: 500, body: { error: 'Server auth is misconfigured.', code: e.code } };
    }
    return { status: 401, body: { error: 'Your session expired — please sign in again.', code: e.code } };
  }
}
