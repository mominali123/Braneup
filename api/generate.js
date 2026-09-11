// Vercel serverless function: POST /api/generate
// Keeps the OpenRouter API key server-side only. Set OPENROUTER_API_KEY in
// Vercel → Project → Settings → Environment Variables.
//
// Access control (auth + free/pro quota) is centralized in
// api/_lib/checkAccess.js — see that file for the Firestore schema.

const { checkAccess } = require('./_lib/checkAccess');
const { capLength } = require('./_lib/inputLimits');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
// Generous cap for this schema's expected output (strategy + positioning +
// visual system + verbal system + brand protection). Adjust upward only if
// legitimate responses start getting cut off (surfaces as a JSON parse
// error in the logs, not a silent truncation).
const MAX_OUTPUT_TOKENS = 3000;

const SYSTEM_PROMPT = `You are Brane, an elite, enterprise-grade brand strategist and visual identity designer. Your goal is to transform a simple business brief into a comprehensive, cohesive, and deeply structured brand identity system.
You do not write generic filler or platitudes. Every piece of strategy must be highly tailored, practical, and immediately actionable for a business looking to launch.
### OUTPUT RULES:
1. Never use placeholder text like "[Value]", "TBD", or generic descriptions. Invent concrete, highly specific content grounded entirely in the brief's context.
2. Colors: You must output a highly functional 5-color palette. The hex codes must be mathematically cohesive (e.g., matching contrast accessibility standards) and explicitly include a Dominant, Supporting, Accent, Dark Neutral, and Light Neutral role.
3. Typography: Provide a real display/header font and a highly legible body font, both actively available on Google Fonts.
4. Consistency: The tone, visual suggestions, and copy strategy must feel like they were developed by a single creative director.
5. Format: You must respond ONLY with a single, valid, raw JSON object matching the schema below. No markdown wrapping (do not use \`\`\`json), no conversational filler, and no trailing comments.
### JSON SCHEMA:
{
  "brandName": "string",
  "metadata": {
    "industry": "string",
    "primaryVibe": "string (e.g., Minimalist, Brutalist, Classic, High-Tech)"
  },
  "strategy": {
    "purpose": "string (The core 'Why' behind the brand)",
    "vision": "string (Where the brand wants to be in 5 years)",
    "mission": "string (How the brand achieves its purpose daily)",
    "values": [
      {
        "name": "string (Single word or short phrase)",
        "description": "string (How this value dictates behavior, 1-2 sentences)"
      }
    ]
  },
  "positioning": {
    "elevatorPitch": "string (A compelling 30-second pitch)",
    "targetAudience": {
      "personaName": "string",
      "demographics": "string",
      "corePainPoint": "string"
    },
    "marketDifferentiator": "string (The clear, singular advantage over competitors)"
  },
  "visualSystem": {
    "colors": [
      {
        "name": "string (Creative color name, e.g., 'Midnight Petrol')",
        "hex": "#rrggbb",
        "role": "dominant | supporting | accent | dark-neutral | light-neutral",
        "rationale": "string (Why this color fits the psychology of the brand)"
      }
    ],
    "typography": {
      "displayFont": "string (Google Font name for headers)",
      "bodyFont": "string (Google Font name for body text)",
      "rationale": "string (Why this pairing works structurally and emotionally)"
    },
    "uiKitTokens": {
      "borderRadius": "string (e.g., '2px' for sharp/premium, '8px' for soft/modern)",
      "shadowStyle": "string (e.g., 'flat borders', 'soft ambient shadows')"
    }
  },
  "verbalSystem": {
    "toneTraits": [
      {
        "trait": "string",
        "howToUse": "string (e.g., 'Write this way...')",
        "whatToAvoid": "string (e.g., 'Do not write this way...')"
      }
    ],
    "tagline": "string",
    "keyMessages": {
      "heroHeader": "string (The main website landing page headline)",
      "subHeader": "string (The supporting copy)",
      "socialBio": "string (A punchy 150-character bio)"
    }
  },
  "brandProtection": {
    "trademarkSafetyLevel": "Low Risk | Medium Risk | High Risk (Analyze the name and industry for obvious conflicts)",
    "ipStrategy": "string (Immediate legal/trademark steps the company should take)",
    "domainSuggestions": ["string", "string", "string"]
  }
}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const access = await checkAccess(req, 'brand');
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

  const businessName = capLength(body.businessName, 120);
  const description = capLength(body.description, 1200);
  const audience = capLength(body.audience, 300);
  const values = capLength(body.values, 300);
  const tone = capLength(body.tone, 300);

  if (!businessName || !description) {
    return res.status(400).json({ error: 'businessName and description are required.' });
  }

  const brief = `Business name: ${businessName}
What it does: ${description}
Target audience: ${audience || 'not specified — infer a sensible one'}
Core values/words the founder cares about: ${values || 'not specified — infer from the description'}
Desired tone: ${tone || 'not specified — choose what fits best'}`;

  try {
    const orRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://braneup.com',
        'X-Title': 'Brane'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.7,
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
        error: `The brand model failed to respond (status ${orRes.status}). Try again.`
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
      return res.status(502).json({ error: 'The brand model returned something unreadable. Try again.' });
    }

    // Only counts against the free monthly quota once generation has
    // actually succeeded — a failed call shouldn't burn the user's quota.
    if (access.recordUsage) await access.recordUsage();

    return res.status(200).json(data);
  } catch (err) {
    console.error('Unexpected error calling OpenRouter:', err);
    return res.status(500).json({ error: 'Unexpected server error. Try again.' });
  }
};
