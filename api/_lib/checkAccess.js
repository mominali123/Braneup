// api/_lib/checkAccess.js
//
// Single shared gate for every /api/generate-* endpoint. Verifies the
// Firebase ID token AND enforces plan/quota rules, so no endpoint can
// accidentally skip the plan check.
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
//   if (access.recordUsage) await access.recordUsage(); // brand tool only, after a successful generation
//
// ---------------------------------------------------------------------
// PRO STATUS — SOURCE OF TRUTH
// ---------------------------------------------------------------------
// Pro access is granted manually: a user counts as Pro only if their
// Firestore users/{uid} document has proStatus: 'active', set directly
// on the document (e.g. by an admin comping an account). There is no
// automated payment gateway wired up — nothing here or anywhere else
// in this file writes or reads subscription billing state.
// ---------------------------------------------------------------------

const admin = require('firebase-admin');

const FREE_BRAND_GENERATIONS_PER_MONTH = 5;

// ---------------------------------------------------------------------
// BASIC RATE LIMITING
// ---------------------------------------------------------------------
// A minimum gap, per user per tool, between accepted generation
// requests. This is a simple cooldown stored on the user's own
// Firestore document (users/{uid}.generationCooldowns.<tool>), not a
// sliding-window or token-bucket limiter — it exists to stop a script
// from hammering an endpoint in a tight loop (which costs OpenRouter
// credits per call even on failure paths upstream of this check), not
// to enforce a precise rate. Pro tools have no monthly quota at all,
// so this is their only defense against runaway/automated use.
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

function isSameMonth(tsA, tsB) {
  return tsA.getUTCFullYear() === tsB.getUTCFullYear() && tsA.getUTCMonth() === tsB.getUTCMonth();
}

function isProActive(userData) {
  return !!(userData && userData.proStatus === 'active');
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
  const isPro = isProActive(userData);

  // OD / HR / Scan are Pro-only, full stop.
  if (tool === 'od' || tool === 'hr' || tool === 'scan') {
    if (!isPro) {
      return {
        ok: false,
        status: 403,
        error: 'This tool is included with Brane Pro. Contact us to unlock it.'
      };
    }

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

  // Brand tool: unlimited for Pro, metered for Free.
  if (tool === 'brand') {
    if (isPro) {
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
        error: `You've used your ${FREE_BRAND_GENERATIONS_PER_MONTH} free brand generations this month. Contact us to upgrade to Pro for unlimited generations.`
      };
    }

    const cooldown = await enforceCooldown(userRef, userData, tool);
    if (cooldown.limited) {
      return {
        ok: false,
        status: 429,
        error: `You're generating a bit fast — please wait ${cooldown.retryAfter}s and try again.`
      };
    }

    // Caller should invoke this only after a successful generation, so
    // a failed call doesn't burn the user's quota.
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
        console.error('Failed to record brand generation usage:', err);
      }
    };

    return { ok: true, uid, recordUsage };
  }

  return { ok: false, status: 400, error: 'Unknown tool.' };
}

module.exports = { checkAccess, FREE_BRAND_GENERATIONS_PER_MONTH };
