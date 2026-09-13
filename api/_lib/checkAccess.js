// api/_lib/checkAccess.js
//
// Single shared gate for every /api/generate-* endpoint. Verifies the
// Firebase ID token and enforces a basic per-tool cooldown, so no
// endpoint can accidentally skip auth or let a script hammer it in a
// tight loop.
//
// ---------------------------------------------------------------------
// ACCESS MODEL — ALL TOOLS FREE, NO QUOTA
// ---------------------------------------------------------------------
// Every signed-in user gets unlimited generations on all four tools
// (brand, od, hr, scan). There is no Pro/Free split and no monthly
// quota anymore — proStatus and brandGenerationsUsed on users/{uid}
// are no longer read here. The only remaining protection is the
// per-tool cooldown below, which exists purely to stop a script from
// hammering an endpoint in a tight loop (each call costs OpenRouter
// credits even on failure paths upstream of this check).
// ---------------------------------------------------------------------
//
// Usage inside a handler:
//
//   const { checkAccess } = require('./_lib/checkAccess');
//   const access = await checkAccess(req, 'hr'); // 'brand' | 'od' | 'hr' | 'scan'
//   if (!access.ok) {
//     return res.status(access.status).json({ error: access.error });
//   }
//   const uid = access.uid;
//   ... proceed to call OpenRouter ...

const admin = require('firebase-admin');

// ---------------------------------------------------------------------
// BASIC RATE LIMITING
// ---------------------------------------------------------------------
// A minimum gap, per user per tool, between accepted generation
// requests. This is a simple cooldown stored on the user's own
// Firestore document (users/{uid}.generationCooldowns.<tool>), not a
// sliding-window or token-bucket limiter — it exists to stop a script
// from hammering an endpoint in a tight loop, not to enforce a precise
// rate. With no quota at all on any tool, this is every tool's only
// defense against runaway/automated use.
//
// Known limitation: the read-then-write below is not a Firestore
// transaction, so two requests arriving within milliseconds of each
// other could both pass the check before either write lands. That's
// an acceptable gap for a "basic" limiter aimed at scripted abuse
// (which retries far faster than milliseconds apart); it is not
// intended to be airtight against a determined, carefully-timed
// attacker. Tighten with a transaction if that ever matters more than
// the added latency/cost of a transactional read+write on every call.
// ---------------------------------------------------------------------
const COOLDOWN_SECONDS = {
  brand: 15,
  od: 20,
  hr: 20,
  scan: 20
};

function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    try {
      return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (err) {
      console.error('FIREBASE_SERVICE_ACCOUNT_KEY is set but is not valid JSON or base64-encoded JSON.');
      return null;
    }
  }
}

if (!admin.apps.length) {
  const serviceAccount = loadServiceAccount();
  if (serviceAccount) {
    try {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } catch (err) {
      console.error('Failed to initialize Firebase Admin:', err);
    }
  } else {
    console.error('Firebase Admin not initialized — check FIREBASE_SERVICE_ACCOUNT_KEY in Vercel.');
  }
}

/**
 * Enforces the per-tool cooldown for a user. Reads the last-accepted
 * timestamp out of the already-fetched `userData` (no extra read), and
 * if enough time has passed, stamps a fresh timestamp so the next call
 * is measured against this one.
 *
 * @param {FirebaseFirestore.DocumentReference} userRef
 * @param {object} userData - already-fetched data() for this user
 * @param {'brand'|'od'|'hr'|'scan'} tool
 * @returns {Promise<{limited: false} | {limited: true, retryAfter: number}>}
 */
async function enforceCooldown(userRef, userData, tool) {
  const cooldownSeconds = COOLDOWN_SECONDS[tool] || 15;
  const lastAt = userData.generationCooldowns && userData.generationCooldowns[tool]
    ? userData.generationCooldowns[tool].toDate()
    : null;

  if (lastAt) {
    const elapsedSeconds = (Date.now() - lastAt.getTime()) / 1000;
    if (elapsedSeconds < cooldownSeconds) {
      return { limited: true, retryAfter: Math.ceil(cooldownSeconds - elapsedSeconds) };
    }
  }

  try {
    // Dot-notation field path so `merge: true` updates only this
    // tool's timestamp inside the map, instead of replacing the whole
    // generationCooldowns object and wiping out the other tools' entries.
    await userRef.set(
      { [`generationCooldowns.${tool}`]: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (err) {
    // If the stamp write fails, fail open rather than blocking a
    // legitimate request over a logging/throttling concern.
    console.error(`Failed to record generation cooldown for tool "${tool}":`, err);
  }

  return { limited: false };
}

/**
 * Verifies the caller's Firebase ID token and enforces the cooldown
 * for the given tool. Every tool is free and unlimited for any
 * signed-in user — there is no Pro/Free split and no monthly quota.
 *
 * @param {import('http').IncomingMessage} req
 * @param {'brand'|'od'|'hr'|'scan'} tool
 * @returns {Promise<{ok: true, uid: string} | {ok: false, status: number, error: string}>}
 */
async function checkAccess(req, tool) {
  if (!['brand', 'od', 'hr', 'scan'].includes(tool)) {
    return { ok: false, status: 400, error: 'Unknown tool.' };
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return { ok: false, status: 401, error: 'Sign in required.' };
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    console.error('ID token verification failed:', err);
    return { ok: false, status: 401, error: 'Your session expired — please sign in again.' };
  }

  const uid = decoded.uid;
  const userRef = admin.firestore().collection('users').doc(uid);

  let userSnap;
  try {
    userSnap = await userRef.get();
  } catch (err) {
    console.error('Failed to read user doc for access check:', err);
    return { ok: false, status: 500, error: 'Could not verify your session. Try again.' };
  }

  const userData = userSnap.exists ? userSnap.data() : {};

  const cooldown = await enforceCooldown(userRef, userData, tool);
  if (cooldown.limited) {
    return {
      ok: false,
      status: 429,
      error: `You're generating a bit fast — please wait ${cooldown.retryAfter}s and try again.`
    };
  }

  return { ok: true, uid };
}

module.exports = { checkAccess };
