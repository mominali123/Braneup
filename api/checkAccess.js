// api/_lib/checkAccess.js
//
// Single shared gate for every /api/generate-* endpoint. Verifies the
// Firebase ID token AND enforces plan/quota rules, so no endpoint can
// accidentally skip the plan check the way generate-hr.js and
// generate-scan.js currently do (auth-only, no tier check).
//
// Usage inside a handler:
//
//   const { checkAccess } = require('./_lib/checkAccess');
//   const access = await checkAccess(req, 'hr'); // 'brand' | 'od' | 'hr' | 'scan'
//   if (!access.ok) {
//     return res.status(access.status).json({ error: access.error });
//   }
//   const uid = access.uid;
//   ... proceed to call Groq ...
//   if (access.recordUsage) await access.recordUsage(); // brand tool only, after a successful generation
//
// Firestore schema this relies on, under users/{uid}:
//   plan: 'free' | 'pro'                  (informational; proStatus is the source of truth)
//   proStatus: 'active' | 'cancelled' | 'past_due' | undefined
//   brandGenerationsUsed: number
//   brandGenerationsPeriodStart: Firestore Timestamp
//
// Free-tier reset policy: fixed calendar month (resets whenever the
// current month differs from brandGenerationsPeriodStart's month) —
// simplest to reason about and to display ("resets on the 1st").
// Swap to rolling-30-day here if you'd rather do that; it's the one
// open decision from the project notes.

const admin = require('firebase-admin');

const FREE_BRAND_GENERATIONS_PER_MONTH = 5;

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

function isSameMonth(tsA, tsB) {
  return tsA.getUTCFullYear() === tsB.getUTCFullYear() && tsA.getUTCMonth() === tsB.getUTCMonth();
}

/**
 * Verifies the caller's Firebase ID token and enforces plan/quota rules
 * for the given tool.
 *
 * @param {import('http').IncomingMessage} req
 * @param {'brand'|'od'|'hr'|'scan'} tool
 * @returns {Promise<{ok: true, uid: string, recordUsage?: () => Promise<void>} | {ok: false, status: number, error: string}>}
 */
async function checkAccess(req, tool) {
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
    return { ok: false, status: 500, error: 'Could not verify your plan. Try again.' };
  }

  const userData = userSnap.exists ? userSnap.data() : {};
  const isPro = userData.proStatus === 'active';

  // OD / HR / Scan are Pro-only, full stop.
  if (tool === 'od' || tool === 'hr' || tool === 'scan') {
    if (!isPro) {
      return {
        ok: false,
        status: 403,
        error: 'This tool is included with Brane Pro. Upgrade to unlock it.'
      };
    }
    return { ok: true, uid };
  }

  // Brand tool: unlimited for Pro, metered for Free.
  if (tool === 'brand') {
    if (isPro) {
      return { ok: true, uid };
    }

    const now = new Date();
    const periodStart = userData.brandGenerationsPeriodStart
      ? userData.brandGenerationsPeriodStart.toDate()
      : null;
    const inCurrentPeriod = periodStart && isSameMonth(periodStart, now);
    const usedThisPeriod = inCurrentPeriod ? (userData.brandGenerationsUsed || 0) : 0;

    if (usedThisPeriod >= FREE_BRAND_GENERATIONS_PER_MONTH) {
      return {
        ok: false,
        status: 403,
        error: `You've used your ${FREE_BRAND_GENERATIONS_PER_MONTH} free brand generations this month. Upgrade to Pro for unlimited generations.`
      };
    }

    // Caller should invoke this only after a successful Groq generation,
    // so a failed call doesn't burn the user's quota.
    const recordUsage = async () => {
      try {
        await userRef.set(
          {
            brandGenerationsUsed: inCurrentPeriod ? admin.firestore.FieldValue.increment(1) : 1,
            brandGenerationsPeriodStart: inCurrentPeriod
              ? userData.brandGenerationsPeriodStart
              : admin.firestore.FieldValue.serverTimestamp(),
            plan: 'free'
          },
          { merge: true }
        );
      } catch (err) {
        // Don't fail the request over a bookkeeping write — just log it.
        console.error('Failed to record brand generation usage:', err);
      }
    };

    return { ok: true, uid, recordUsage };
  }

  return { ok: false, status: 400, error: 'Unknown tool.' };
}

module.exports = { checkAccess, FREE_BRAND_GENERATIONS_PER_MONTH };
