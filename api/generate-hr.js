// Vercel serverless function: POST /api/generate-hr
// Uses OpenRouter API with google/gemma-4-26b-a4b-it:free model.
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
const MODEL = 'google/gemma-4-26b-a4b-it:free';

const SYSTEM_PROMPT = `You are Brane HR, an elite HR consultant who writes precise, professional job descriptions for companies. Your goal is to transform a short brief about a role into a comprehensive, well-structured job description document.
You do not write generic filler or platitudes. Every section must be highly tailored, practical, and immediately usable by an HR department to post the role and evaluate candidates against it.
### OUTPUT RULES:
1. Never use placeholder text like "[Value]", "TBD", or generic descriptions. Invent concrete, highly specific content grounded entirely in the brief's context.
2. Responsibilities must be specific, numbered action statements (start with a verb), not vague platitudes.
3. Skills & capabilities and key result areas must be concrete and measurable where possible.
4. Version info: dateDocumented should be today's date and reviewDate should be 12 months from today, both in a short human-readable format (e.g. "24 July 2026"). version should be "1.0" unless context suggests otherwise.
5. Format: You must respond ONLY with a single, valid, raw JSON object matching the schema below. No markdown wrapping (do not use \`\`\`json), no conversational filler, and no trailing comments.
### JSON SCHEMA:
{
  "jobTitle": "string",
  "metadata": {
    "department": "string",
    "reportingTo": "string (title of the role this position reports to)"
  },
  "versionInfo": {
    "version": "string (e.g. '1.0')",
    "dateDocumented": "string (human-readable date)",
    "reviewDate": "string (human-readable date, ~12 months out)"
  },
  "purpose": "string (2-3 sentences on why this role exists and what it achieves for the organization)",
  "responsibilities": ["string (a specific duty/task, verb-first, 6-10 items)"],
  "jobSpecification": {
    "skillsAndCapabilities": ["string (a specific skill or capability, 5-9 items)"],
    "keyResultAreas": ["string (a measurable area this role is accountable for, 3-6 items)"]
  },
  "experience": {
    "years": "string (e.g. '3-5 years')",
    "relevance": "string (what kind of prior experience is relevant)",
    "quality": "string (what level/caliber of experience is expected)"
  },
  "interaction": {
    "internalCustomers": "string (who this role serves/supports internally)",
    "internalCustomerOf": "string (which internal teams/roles this position depends on or is served by)"
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

  const jobTitle = (body.jobTitle || '').toString().trim();
  const department = (body.department || '').toString().trim();
  const reportingTo = (body.reportingTo || '').toString().trim();
  const description = (body.description || '').toString().trim();
  const experience = (body.experience || '').toString().trim();
  const skills = (body.skills || '').toString().trim();
  const interaction = (body.interaction || '').toString().trim();

  if (!jobTitle || !description) {
    return res.status(400).json({ error: 'jobTitle and description are required.' });
  }

  const todayStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const brief = `Job title: ${jobTitle}
Department: ${department || 'not specified — infer a sensible one'}
Reports to: ${reportingTo || 'not specified — infer a sensible one'}
What the role does: ${description}
Experience required (as given by the requester, refine and expand): ${experience || 'not specified — infer from the description'}
Key skills (as given by the requester, refine and expand): ${skills || 'not specified — infer from the description'}
Who they work with (as given by the requester, refine and expand): ${interaction || 'not specified — infer from the description'}
Today's date, for versionInfo.dateDocumented: ${todayStr}`;

  try {
    const orRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://braneup.com',
        'X-Title': 'Brane HR'
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
        error: `The HR model failed to respond (status ${orRes.status}). Try again.`
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
      return res.status(502).json({ error: 'The HR model returned something unreadable. Try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error calling OpenRouter:', err);
    return res.status(500).json({ error: 'Unexpected server error. Try again.' });
  }
};
