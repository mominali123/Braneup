// Vercel serverless function: POST /api/generate-od
// Same pattern as /api/generate.js (the brand tool): keeps the Groq API
// key server-side only (set GROQ_API_KEY in Vercel → Project → Settings →
// Environment Variables) and requires a signed-in Firebase user — the
// browser sends the user's ID token in the Authorization header, and this
// function verifies it with firebase-admin before calling Groq. The
// service account credentials live in the FIREBASE_SERVICE_ACCOUNT_KEY
// env var — never in code. Store it base64-encoded (recommended — see
// README) or as raw JSON; either is accepted below.

const admin = require('firebase-admin');

function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) return null;

  // Raw JSON, possibly with stray leading/trailing whitespace from a paste.
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Fall back to base64-encoded JSON — immune to whitespace/newline
    // mangling since base64 has no meaningful line breaks.
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

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are Brane OD, an elite organizational development (OD) consultant and organizational designer. Your goal is to transform a short brief about a business into a comprehensive, deeply structured organizational development diagnostic covering organizational design (contextual and structural dimensions) and organizational culture, grounded in classic OD/organizational-theory frameworks (Daft's contextual & structural dimensions, Robbins' culture dimensions, Cameron & Quinn's competing values framework).
You do not write generic filler or platitudes. Every recommendation must be highly tailored, practical, and immediately actionable for the specific organization described in the brief.
### OUTPUT RULES:
1. Never use placeholder text like "[Value]", "TBD", or generic descriptions. Invent concrete, highly specific content grounded entirely in the brief's context.
2. Every enumerated rating field (things like variety, analyzability, formalization, specialization, professionalism, bureaucracy sub-items, culture dimensions) must be one of the exact allowed labels given in the schema notes below — never invent new labels.
3. Structure vs culture must feel coherent — e.g. a highly organic, decentralized structure should pair with a culture profile that supports it, and vice versa.
4. Recommendations must be prioritized and realistic for the organization's actual size and stage as described.
5. Format: You must respond ONLY with a single, valid, raw JSON object matching the schema below. No markdown wrapping (do not use \`\`\`json), no conversational filler, and no trailing comments.
### JSON SCHEMA:
{
  "organizationName": "string",
  "metadata": {
    "industry": "string",
    "size": "string (short human-readable size descriptor, e.g. '45 employees, single office')"
  },
  "organizationalDesign": {
    "contextual": {
      "goalsAndStrategies": {
        "vision": "string",
        "mission": "string",
        "goals": "string (2-4 concrete goals)",
        "competitiveStrategy": "Low Cost Leadership | Differentiation | Focus",
        "corporateStrategy": "string",
        "functionalStrategy": "string",
        "operationalStrategy": "string"
      },
      "departmentFunction": "string (which department/function this diagnostic centers on, or 'Whole organization')",
      "departmentalTechnology": {
        "type": "Craft | Engineering | Routine | Non-routine",
        "variety": "HI | LO (number of unexpected tasks)",
        "analyzability": "HI | LO (number of analyzable tasks)"
      },
      "managementProcess": "Organic | Mechanistic",
      "environmentalUncertainty": {
        "complexity": "Simple | Complex",
        "stability": "Stable | Unstable"
      },
      "hrActivities": ["string (specific HR activities to prioritize, 4-7 items)"]
    },
    "structural": {
      "structureType": "Simple | Functional | Divisional | Team-based | Matrix | Project-based",
      "centralization": "Centralized | Decentralized",
      "hierarchyOfAuthority": "Tall | Medium | Short",
      "spanOfControl": "Narrow | Medium | Wide",
      "formalization": "HI | MED | LO",
      "specialization": "HI | MED | LO",
      "professionalism": "HI | MED | LO",
      "departmentalization": {
        "basis": "string (short description of the primary basis used)",
        "functional": true,
        "geographical": false,
        "product": false,
        "process": false,
        "customer": false
      },
      "bureaucracy": {
        "level": "HI | MED | LO",
        "formalRules": "HI | MED | LO",
        "impersonality": "HI | MED | LO",
        "careerOrientation": "HI | MED | LO",
        "divisionOfLabor": "HI | MED | LO",
        "authorityHierarchy": "HI | MED | LO",
        "formalSelection": "HI | MED | LO"
      },
      "personnelRatios": {
        "totalEmployees": "string",
        "administrativeStaff": "string",
        "clericalStaff": "string",
        "professionalStaff": "string"
      }
    }
  },
  "organizationalCulture": {
    "dimensions": {
      "attentionToDetail": "HI | MED | LO",
      "outcomeOrientation": "HI | MED | LO",
      "peopleOrientation": "HI | MED | LO",
      "teamOrientation": "HI | MED | LO",
      "aggressiveness": "HI | MED | LO",
      "stability": "HI | MED | LO",
      "innovationRiskTaking": "HI | MED | LO",
      "efficiency": "HI | MED | LO",
      "effectiveness": "HI | MED | LO"
    },
    "cultureType": "Adaptability/Entrepreneurial | Mission | Clan | Bureaucratic",
    "materialSymbols": {
      "dressCode": "string",
      "transportation": "string (perks/policy for executives vs employees)",
      "perks": "string",
      "benefits": "string",
      "rewardsSystem": "string",
      "physicalSettings": "Traditional | Modern (plus a short description)"
    },
    "culturalTransmission": {
      "stories": "string (a representative story or 'None established yet' plus a suggestion)",
      "rituals": "string",
      "languageJargon": "string",
      "slogans": "string"
    },
    "sharedFoundations": {
      "vision": "string",
      "values": "string",
      "norms": "string",
      "customerCare": "string",
      "socialObligation": "string (meeting economic & legal responsibilities)",
      "socialResponsibility": "string (obligations beyond law & economics)",
      "socialResponsiveness": "string (capacity to adapt to social changes)"
    }
  },
  "recommendations": {
    "quickWins": ["string (things fixable in under 30 days, 2-4 items)"],
    "priorities": ["string (the next 90 days, 3-5 items, ordered by priority)"],
    "risks": ["string (risks if the org doesn't act, 2-4 items)"]
  }
}`;

module.exports = async (req, res) => {
  // Basic CORS/method guard
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing GROQ_API_KEY. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const organizationName = (body.organizationName || '').toString().trim();
  const description = (body.description || '').toString().trim();
  const industry = (body.industry || '').toString().trim();
  const size = (body.size || '').toString().trim();
  const stage = (body.stage || '').toString().trim();
  const challenge = (body.challenge || '').toString().trim();

  if (!organizationName || !description) {
    return res.status(400).json({ error: 'organizationName and description are required.' });
  }

  const brief = `Organization name: ${organizationName}
What it does: ${description}
Industry: ${industry || 'not specified — infer a sensible one'}
Size: ${size || 'not specified — infer a sensible one from the description'}
Stage / current situation: ${stage || 'not specified — infer from the description'}
What's driving this OD effort: ${challenge || 'not specified — infer the likely growing pains from the description and stage'}`;

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
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

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({
        error: `The OD model failed to respond (status ${groqRes.status}). Try again.`
      });
    }

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();

    let data;
    try {
      data = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse model output:', raw);
      return res.status(502).json({ error: 'The OD model returned something unreadable. Try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error calling Groq:', err);
    return res.status(500).json({ error: 'Unexpected server error. Try again.' });
  }
};
