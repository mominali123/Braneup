// Vercel serverless function: POST /api/generate-scan
// Uses OpenRouter API with nvidia/nemotron-3.5-lightning:free model.
// Set OPENROUTER_API_KEY and FIREBASE_SERVICE_ACCOUNT_KEY in Vercel env vars.

const admin = require('firebase-admin');

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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'nvidia/nemotron-3.5-lightning:free';

const SYSTEM_PROMPT = `You are Brane Scan, an elite market and competitive intelligence analyst who runs structured environmental scans for businesses. Your goal is to transform a short brief about a business into a comprehensive, well-structured environmental scan document.
You do not write generic filler or platitudes. Every section must be highly tailored, practical, and immediately usable by a founder or strategy team to understand exactly where the business is exposed and where it's ahead. Ground every claim in the specific brief given — industry, market/geography, named competitors, and stage — rather than producing a generic template with blanks filled in.
### OUTPUT RULES:
1. Never use placeholder text like "[Value]", "TBD", or generic descriptions. Invent concrete, highly specific content grounded entirely in the brief's context. If named competitors were given, analyze those specific competitors — do not invent unrelated ones.
2. PESTLE fields must each be 1-3 concrete, specific points relevant to this business's actual industry and market — not generic macro commentary.
3. SWOT items must be specific, single-sentence statements grounded in the brief — not vague platitudes like "strong team" or "market risk."
4. Porter's five forces entries should each be a short assessment (e.g. "High — low switching costs and many alternatives") rather than a bare label.
5. Format: You must respond ONLY with a single, valid, raw JSON object matching the schema below. No markdown wrapping (do not use \`\`\`json), no conversational filler, and no trailing comments.
### JSON SCHEMA:
{
  "organizationName": "string",
  "metadata": {
    "industry": "string",
    "market": "string (geography / market scope)"
  },
  "pestle": {
    "political": ["string", "1-3 items"],
    "economic": ["string", "1-3 items"],
    "social": ["string", "1-3 items"],
    "technological": ["string", "1-3 items"],
    "legal": ["string", "1-3 items"],
    "environmental": ["string", "1-3 items"]
  },
  "competitiveLandscape": {
    "summary": "string (2-3 sentences on how the competitive field is structured)",
    "competitors": [
      { "name": "string", "strengths": "string", "weaknesses": "string" }
    ],
    "forces": {
      "newEntrants": "string (assessment, e.g. 'Low — high capital requirements and regulatory barriers')",
      "rivalry": "string (assessment)",
      "supplierPower": "string (assessment)",
      "customerPower": "string (assessment)",
      "substitutes": "string (assessment)"
    }
  },
  "swot": {
    "strengths": ["string", "3-5 items"],
    "weaknesses": ["string", "3-5 items"],
    "opportunities": ["string", "3-5 items"],
    "threats": ["string", "3-5 items"]
  },
  "emergingRisksOpportunities": {
    "risks": ["string (a specific risk on the horizon, not yet fully in play, 2-4 items)"],
    "opportunities": ["string (a specific opportunity on the horizon, 2-4 items)"]
  },
  "marketPositioning": {
    "summary": "string (2-3 sentences on where this business sits relative to direct competitors)",
    "dimensions": [
      { "name": "string (e.g. 'Price', 'Speed', 'Brand trust')", "position": "string (where this business stands on that dimension vs. competitors)" }
    ]
  },
  "recommendations": {
    "quickWins": ["string (low-effort, high-visibility actions, 2-4 items)"],
    "priorities": ["string (priority initiatives for the next 90 days, 2-4 items)"],
    "risks": ["string (risks to watch if these changes aren't made, 2-4 items)"]
  }
}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return res.status(401).json({ error: 'Sign in required.' });
  }
  try {
    await admin.auth().verifyIdToken(match[1]);
  } catch (err) {
    console.error('ID token verification failed:', err);
    return res.status(401).json({ error: 'Your session expired — please sign in again.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing OPENROUTER_API_KEY. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const organizationName = (body.organizationName || '').toString().trim();
  const description = (body.description || '').toString().trim();
  const industry = (body.industry || '').toString().trim();
  const market = (body.market || '').toString().trim();
  const competitors = (body.competitors || '').toString().trim();
  const stage = (body.stage || '').toString().trim();
  const challenge = (body.challenge || '').toString().trim();

  if (!organizationName || !description) {
    return res.status(400).json({ error: 'organizationName and description are required.' });
  }

  const brief = `Business / brand name: ${organizationName}
What it does: ${description}
Industry: ${industry || 'not specified — infer a sensible one from the description'}
Market / geography: ${market || 'not specified — infer a sensible one from the description'}
Direct competitors (as given by the requester, refine and expand if useful): ${competitors || 'not specified — infer 2-4 plausible direct competitors from the industry and market'}
Stage / current situation: ${stage || 'not specified — infer from the description'}
What's prompting this scan: ${challenge || 'not specified — run a general environmental scan covering the standard risks and opportunities for a business like this'}`;

  try {
    const orRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://braneup.com',
        'X-Title': 'Brane Scan'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: brief }
        ]
      })
    });

    if (!orRes.ok) {
      const errText = await orRes.text();
      console.error('OpenRouter API error:', orRes.status, errText);
      return res.status(502).json({
        error: `The scan model failed to respond (status ${orRes.status}). Try again.`
      });
    }

    const orData = await orRes.json();
    const raw = orData.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse model output:', raw);
      return res.status(502).json({ error: 'The scan model returned something unreadable. Try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error calling OpenRouter:', err);
    return res.status(500).json({ error: 'Unexpected server error. Try again.' });
  }
};
