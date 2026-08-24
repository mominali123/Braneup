// api/paypal-webhook.js
//
// POST endpoint PayPal calls for subscription billing events. Register
// this exact URL in PayPal Developer Dashboard → your Live app →
// Webhooks:
//
//   https://braneup.com/api/paypal-webhook
//
// Subscribe it to at least:
//   BILLING.SUBSCRIPTION.CREATED
//   BILLING.SUBSCRIPTION.ACTIVATED
//   BILLING.SUBSCRIPTION.UPDATED
//   BILLING.SUBSCRIPTION.EXPIRED
//   BILLING.SUBSCRIPTION.CANCELLED
//   BILLING.SUBSCRIPTION.SUSPENDED
//   BILLING.SUBSCRIPTION.PAYMENT.FAILED
//   PAYMENT.SALE.COMPLETED
//   PAYMENT.SALE.REFUNDED
//   PAYMENT.SALE.REVERSED
//
// ---------------------------------------------------------------------
// HOW A PAYMENT GETS LINKED TO A BRANE ACCOUNT
// ---------------------------------------------------------------------
// The pricing page uses a PayPal Hosted Button (CVSTVKADMVCSE), which is
// configured entirely on PayPal's servers and exposes no client-side
// onApprove/createSubscription callback — so the browser never learns a
// subscriptionID, and there's no way to attach the signer's Firebase uid
// at checkout time.
//
// Instead, this webhook matches the PayPal subscriber's checkout email
// to a Firebase Auth account by email (admin.auth().getUserByEmail).
// This works as long as the buyer pays with the same email as their
// Brane login. If it doesn't match, the event is NOT silently dropped —
// it's recorded under paypalUnmatchedSubscriptions/{subscriptionId} for
// manual reconciliation, and still ack'd 2xx so PayPal doesn't retry
// forever (retrying won't fix an email mismatch on its own).
// ---------------------------------------------------------------------

const admin = require('firebase-admin');
const { verifyWebhookSignature, getSubscriptionDetails } = require('./_lib/paypal');

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

const SUBSCRIPTION_EVENT_TYPES = new Set([
  'BILLING.SUBSCRIPTION.CREATED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED'
]);

async function findUidByEmail(email) {
  if (!email) return null;
  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return userRecord.uid;
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return null;
    throw err;
  }
}

async function recordUnmatched(subscriptionId, email, eventType, raw) {
  try {
    await admin.firestore().collection('paypalUnmatchedSubscriptions').doc(subscriptionId).set({
      email: email || null,
      lastEventType: eventType,
      lastEventAt: admin.firestore.FieldValue.serverTimestamp(),
      rawResource: raw
    }, { merge: true });
  } catch (err) {
    console.error('Failed to record unmatched PayPal subscription:', err);
  }
}

// Pulls canonical subscription state from PayPal and writes it onto the
// matched user's Firestore doc. Used for every subscription-lifecycle
// event and for sale events that reference a subscription — always
// re-fetching from PayPal rather than trusting whichever partial fields
// happen to be on a given webhook payload (these vary by event type).
async function syncSubscriptionToUser(subscriptionId, eventType) {
  const sub = await getSubscriptionDetails(subscriptionId);
  const email = sub.subscriber && sub.subscriber.email_address;
  const uid = await findUidByEmail(email);

  if (!uid) {
    await recordUnmatched(subscriptionId, email, eventType, sub);
    console.warn(`PayPal subscription ${subscriptionId} (${eventType}) has no matching Firebase user for email ${email}.`);
    return;
  }

  const status = sub.status; // APPROVAL_PENDING | APPROVED | ACTIVE | SUSPENDED | CANCELLED | EXPIRED
  const nextBillingTime = sub.billing_info && sub.billing_info.next_billing_time
    ? new Date(sub.billing_info.next_billing_time)
    : null;
  const lastPaymentTime = sub.billing_info && sub.billing_info.last_payment && sub.billing_info.last_payment.time
    ? new Date(sub.billing_info.last_payment.time)
    : null;

  const userRef = admin.firestore().collection('users').doc(uid);
  const existingSnap = await userRef.get();
  const existing = (existingSnap.exists && existingSnap.data().subscription) || {};

  // CANCELLED: PayPal typically clears next_billing_time by the time
  // this event lands, so keep whatever period-end we already knew —
  // that's what lets the user keep Pro through the period they already
  // paid for (refund-policy.html §5), instead of losing access the
  // instant they hit "cancel".
  const currentPeriodEnd = status === 'CANCELLED'
    ? (existing.currentPeriodEnd || null)
    : (nextBillingTime || existing.currentPeriodEnd || null);

  const stillInGracePeriod = status === 'CANCELLED' && currentPeriodEnd && currentPeriodEnd > new Date();

  await userRef.set({
    plan: (status === 'ACTIVE' || stillInGracePeriod) ? 'pro' : 'free',
    subscription: {
      provider: 'paypal',
      paypalSubscriptionId: subscriptionId,
      paypalEmail: email || existing.paypalEmail || null,
      status,
      cancelAtPeriodEnd: status === 'CANCELLED',
      currentPeriodEnd,
      lastPaymentAt: lastPaymentTime || existing.lastPaymentAt || null,
      lastEventType: eventType,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true });
}

// PAYMENT.SALE.* events reference their subscription via
// resource.billing_agreement_id — resource.id on those events is the
// sale/transaction id, not the subscription id.
function subscriptionIdFromSaleResource(resource) {
  return (resource && resource.billing_agreement_id) || null;
}

// Immediate, no-grace revocation — used for refunds/reversals, where we
// deliberately do NOT trust PayPal's live subscription status (it may
// still say ACTIVE even after a specific charge was refunded).
async function markRevoked(subscriptionId, status, eventType) {
  // Removed .catch(() => null) so network/fetch failures bubble up to main try/catch
  const sub = await getSubscriptionDetails(subscriptionId);
  const email = sub && sub.subscriber && sub.subscriber.email_address;
  const uid = await findUidByEmail(email);
  if (!uid) {
    await recordUnmatched(subscriptionId, email, eventType, sub || {});
    return;
  }
  await admin.firestore().collection('users').doc(uid).set({
    plan: 'free',
    subscription: {
      provider: 'paypal',
      paypalSubscriptionId: subscriptionId,
      paypalEmail: email || null,
      status,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
      lastEventType: eventType,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || !body.event_type || !body.resource) {
    return res.status(400).json({ error: 'Malformed webhook payload.' });
  }

  // ---- 1. Verify authenticity with PayPal before trusting anything ----
  let verified;
  try {
    verified = await verifyWebhookSignature(req.headers, body);
  } catch (err) {
    console.error('Webhook signature verification errored:', err);
    return res.status(500).json({ error: 'Verification failed.' });
  }
  if (!verified) {
    console.warn('Rejected PayPal webhook: signature verification did not return SUCCESS.', body.event_type, body.id);
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  // ---- 2. Idempotency: PayPal may redeliver the same event ----
  const eventId = body.id;
  if (!eventId) {
    return res.status(400).json({ error: 'Missing event id.' });
  }
  const eventRef = admin.firestore().collection('paypalWebhookEvents').doc(eventId);
  try {
    // .create() is atomic and throws ALREADY_EXISTS if the doc is
    // already there — a clean idempotency guard with no read-then-write
    // race window.
    await eventRef.create({
      eventType: body.event_type,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'received'
    });
  } catch (err) {
    if (err && err.code === 6 /* ALREADY_EXISTS, gRPC status code */) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    console.error('Failed to write idempotency record:', err);
    return res.status(500).json({ error: 'Idempotency check failed.' });
  }

  // ---- 3. Route by event type ----
  try {
    const eventType = body.event_type;
    const resource = body.resource;

    if (SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
      await syncSubscriptionToUser(resource.id, eventType);
    } else if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      // Don't downgrade on a single failed charge — PayPal itself
      // retries, and will eventually emit SUSPENDED or CANCELLED if it
      // truly lapses. Just record it for support visibility.
      const subscriptionId = resource.id;
      const sub = await getSubscriptionDetails(subscriptionId).catch(() => null);
      const email = sub && sub.subscriber && sub.subscriber.email_address;
      const uid = await findUidByEmail(email);
      if (uid) {
        await admin.firestore().collection('users').doc(uid).set({
          subscription: {
            lastPaymentFailedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastEventType: eventType,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        }, { merge: true });
      } else {
        await recordUnmatched(subscriptionId, email, eventType, sub || {});
      }
    } else if (eventType === 'PAYMENT.SALE.COMPLETED') {
      const subscriptionId = subscriptionIdFromSaleResource(resource);
      if (subscriptionId) await syncSubscriptionToUser(subscriptionId, eventType);
    } else if (eventType === 'PAYMENT.SALE.REFUNDED' || eventType === 'PAYMENT.SALE.REVERSED') {
      const subscriptionId = subscriptionIdFromSaleResource(resource);
      if (subscriptionId) {
        await markRevoked(subscriptionId, eventType === 'PAYMENT.SALE.REFUNDED' ? 'REFUNDED' : 'REVERSED', eventType);
      }
    } else {
      // Unhandled event type — ack so PayPal stops retrying, but log it
      // in case it's worth wiring up later.
      console.log('Unhandled PayPal webhook event type:', eventType);
    }

    await eventRef.set({ status: 'processed', processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error processing PayPal webhook:', err);
    await eventRef.set({ status: 'error', error: String((err && err.message) || err) }, { merge: true }).catch(() => {});
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};
