// Vercel serverless function: POST /api/generate-od
// Uses OpenRouter API with openai/gpt-4o-mini model.
// Set OPENROUTER_API_KEY in Vercel env vars.
//
// Access control (auth + Pro-only gate) is centralized in
// api/_lib/checkAccess.js — see that file for the Firestore schema.

const { checkAccess } = require('./_lib/checkAccess');
const { capLength } = require('./_lib/inputLimits');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
// This is the largest schema of the four tools (contextual + structural +
// culture + recommendations, each with many nested fields), so it gets the
// highest cap. Adjust upward only if legitimate responses start getting cut
// off (surfaces as a JSON parse error in the logs, not a silent truncation).
const MAX_OUTPUT_TOKENS = 4000;

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await checkAccess(req, 'od');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
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

  const organizationName = capLength(body.organizationName, 120);
  const description = capLength(body.description, 1200);
  const industry = capLength(body.industry, 200);
  const size = capLength(body.size, 200);
  const stage = capLength(body.stage, 300);
  const challenge = capLength(body.challenge, 1200);

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
    const orRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://braneup.com',
        'X-Title': 'Brane OD'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.6,
        max_tokens: MAX_OUTPUT_TOKENS,
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
        error: `The OD model failed to respond (status ${orRes.status}). Try again.`
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
      return res.status(502).json({ error: 'The OD model returned something unreadable. Try again.' });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error calling OpenRouter:', err);
    return res.status(500).json({ error: 'Unexpected server error. Try again.' });
  }
};
