// api/_lib/paypal.js
//
// Shared PayPal REST helpers for api/paypal-webhook.js and
// api/cancel-subscription.js. Live endpoints only — per the
// integration brief, production must never call PayPal's Sandbox
// host, so this is not configurable via env var.

const PAYPAL_API_BASE = 'https://api-m.paypal.com';

// In-memory only, scoped to a single warm serverless instance. Worst
// case on a cold start we fetch a fresh token — cheap and correct.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in the server environment.');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal OAuth token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in || 300) * 1000
  };
  return cachedToken.accessToken;
}

// Verifies a webhook event's authenticity using PayPal's server-side
// verification endpoint (the recommended approach — avoids implementing
// PayPal's signature/certificate crypto locally). Returns true only if
// PayPal itself confirms SUCCESS.
async function verifyWebhookSignature(headers, webhookEventBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new Error('Missing PAYPAL_WEBHOOK_ID in the server environment.');
  }

  const accessToken = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: webhookEventBody
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('PayPal verify-webhook-signature call failed:', res.status, text);
    return false;
  }

  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

// Fetches the canonical, current state of a subscription directly from
// PayPal, rather than trusting whichever partial fields happen to be
// present on any one webhook payload (these vary by event type).
async function getSubscriptionDetails(subscriptionId) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal get-subscription failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Cancels a subscription on PayPal's side. This only stops future
// billing — it does not touch Firestore. api/cancel-subscription.js
// (the caller) and api/paypal-webhook.js (on the resulting
// BILLING.SUBSCRIPTION.CANCELLED event) are responsible for updating
// the user's plan/subscription record.
async function cancelSubscription(subscriptionId, reason = 'Customer requested cancellation') {
  if (!subscriptionId) {
    throw new Error('Missing PayPal subscription ID.');
  }

  const accessToken = await getAccessToken();
  const res = await fetch(
    `${PAYPAL_API_BASE}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reason })
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal cancel-subscription failed (${res.status}): ${text}`);
  }

  // PayPal returns 204 No Content on success — nothing to parse.
  return true;
}

module.exports = {
  getAccessToken,
  verifyWebhookSignature,
  getSubscriptionDetails,
  cancelSubscription,
  PAYPAL_API_BASE
};
