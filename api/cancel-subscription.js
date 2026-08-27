// api/cancel-subscription.js
//
// POST endpoint that cancels the signed-in user's PayPal subscription.
// The heavy lifting (marking the user free once their paid period
// actually ends) stays owned by api/paypal-webhook.js, which is the
// single source of truth for users/{uid}.subscription — see the notes
// at the top of api/_lib/checkAccess.js. This endpoint just:
//
//   1. Verifies the caller via their Firebase ID token
//   2. Looks up their PayPal subscription ID (never trusts a client-
//      supplied subscription ID — that would let anyone cancel anyone
//      else's subscription)
//   3. Asks PayPal to cancel it
//   4. Optimistically marks cancelAtPeriodEnd on Firestore so the
//      profile page reflects it immediately, without waiting on the
//      BILLING.SUBSCRIPTION.CANCELLED webhook to arrive. The webhook
//      remains authoritative and will reconcile shortly after.

const admin = require('firebase-admin');
const { cancelSubscription, getSubscriptionDetails } = require('./_lib/paypal');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- 1. Verify Firebase auth ----
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Sign in required.' });
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    console.error('ID token verification failed:', err);
    return res.status(401).json({ error: 'Your session expired — please sign in again.' });
  }

  const uid = decoded.uid;
  const userRef = admin.firestore().collection('users').doc(uid);

  // ---- 2. Look up the user's own PayPal subscription ID ----
  let userSnap;
  try {
    userSnap = await userRef.get();
  } catch (err) {
    console.error('Failed to read user doc:', err);
    return res.status(500).json({ error: 'Could not look up your subscription. Try again.' });
  }

  const userData = userSnap.exists ? userSnap.data() : {};
  const subscriptionId = userData.subscription && userData.subscription.paypalSubscriptionId;

  if (!subscriptionId) {
    return res.status(400).json({ error: 'No active PayPal subscription was found on your account.' });
  }

  const currentStatus = userData.subscription && userData.subscription.status;
  if (currentStatus === 'CANCELLED' || currentStatus === 'EXPIRED' || currentStatus === 'REFUNDED' || currentStatus === 'REVERSED') {
    return res.status(400).json({ error: 'This subscription is already cancelled.' });
  }

  // ---- 3. Cancel on PayPal's side ----
  try {
    await cancelSubscription(subscriptionId, 'Customer requested cancellation from Brane profile page');
  } catch (err) {
    console.error('Failed to cancel PayPal subscription:', err);
    return res.status(502).json({ error: 'Could not cancel your subscription with PayPal. Try again.' });
  }

  // ---- 4. Optimistic Firestore update so the UI reflects it now ----
  // The webhook (BILLING.SUBSCRIPTION.CANCELLED) will land shortly
  // after and re-sync from PayPal's canonical state — this is just so
  // the person isn't staring at a stale "Active" badge in the meantime.
  try {
    let currentPeriodEnd = (userData.subscription && userData.subscription.currentPeriodEnd) || null;
    try {
      const freshSub = await getSubscriptionDetails(subscriptionId);
      const nextBillingTime = freshSub.billing_info && freshSub.billing_info.next_billing_time;
      if (nextBillingTime) currentPeriodEnd = new Date(nextBillingTime);
    } catch (fetchErr) {
      console.warn('Could not re-fetch subscription details after cancel; keeping existing currentPeriodEnd.', fetchErr);
    }

    await userRef.set({
      subscription: {
        ...userData.subscription,
        status: 'CANCELLED',
        cancelAtPeriodEnd: true,
        currentPeriodEnd,
        lastEventType: 'CLIENT.CANCEL_REQUEST',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });
  } catch (err) {
    // PayPal cancellation already succeeded at this point — don't fail
    // the request over a Firestore write hiccup, the webhook will
    // reconcile this shortly.
    console.error('PayPal cancelled but Firestore optimistic update failed:', err);
  }

  return res.status(200).json({
    ok: true,
    message: 'Your subscription has been cancelled. Pro access continues through the end of your current billing period.'
  });
};
