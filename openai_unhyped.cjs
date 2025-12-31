const { z } = require('zod');
// --- Simple in-memory cache for score-calibration (same film ≈ same scores) ---
const __CACHE = new Map(); // key -> { ts, value }
const __CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function _normKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function _cacheGet(key) {
  const v = __CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > __CACHE_TTL_MS) { __CACHE.delete(key); return null; }
  return v.value;
}
function _cacheSet(key, value) {
  __CACHE.set(key, { ts: Date.now(), value });
  // basic cap
  if (__CACHE.size > 250) {
    const firstKey = __CACHE.keys().next().value;
    if (firstKey) __CACHE.delete(firstKey);
  }
}

function _hashToInt(str) {
  // deterministic 32-bit hash
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function _clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function _calibrateScore(key, score, meterName) {
  const base = Number(score);
  const safe = Number.isFinite(base) ? base : 0;
  // small deterministic offset per film+meter to reduce jitter between runs
  const h = _hashToInt(`${key}|${meterName}`);
  const offset = (h % 9) - 4; // -4..+4
  const out = Math.round(_clamp(safe + offset, 0, 100));
  return out;
}


function safeJsonParse(text) {
  try { return JSON.parse(text); } catch (_) {}
  const m = text.match(/\{[\s\S]*\}$/m);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) {}
  }
  return null;
}

function clampInt(v, min, max, fallback) {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanList(v, max = 12) {
  if (!Array.isArray(v)) return [];
  return v
    .map(x => String(x ?? '').replace(/^[•\-\–\—]+\s*/g, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function coerceLevel(v) {
  const s = String(v || '').toLowerCase().trim();
  if (['low','medium','high','unknown'].includes(s)) return s;
  if (['laag'].includes(s)) return 'low';
  if (['middel','medium'].includes(s)) return 'medium';
  if (['hoog'].includes(s)) return 'high';
  if (['onbekend','unknown','?'].includes(s)) return 'unknown';
  return 'unknown';
}

const LevelEnum = z.enum(['low','medium','high','unknown']);

const MeterSchema = z.object({
  score: z.coerce.number().int().min(0).max(100).default(0),
  level: LevelEnum.default('unknown'),
  shortWhy: z.string().default(''),
  labels: z.array(z.string()).default([]),
}).default({});

const OutputSchema = z.object({
  identified: z.object({
    title: z.string().default(''),
    year: z.coerce.number().int().min(1800).max(2100).optional().nullable(),
    type: z.enum(['movie','tv','unknown']).default('unknown'),
    confidence: z.enum(['low','medium','high']).default('low'),
  }).default({}),
  filmSummary: z.string().default(''),
  verdict: z.object({
    line: z.string().default(''),
    bullets: z.array(z.string()).default([]),
  }).default({}),
  dashboard: z.object({
    mismatch: MeterSchema,
    hype: MeterSchema,
    influencers: MeterSchema,
  }).default({}),
  worksFor: z.array(z.string()).default([]),
  skipIf: z.array(z.string()).default([]),
  expectationGap: z.object({
    promise: z.string().default(''),
    reality: z.string().default(''),
    why: z.string().default(''),
  }).default({}),
  sources: z.array(z.object({ title: z.string().default(''), url: z.string().default('') })).optional().default([]),
});

async function analyzeImageWithOpenAI({ apiKey, imageBase64, mimeType }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });

  // --- 1) Identify title/year/type from the image (vision only) ---
  const identifySystem = `
Je bent Unhyped.
Taak: herken alleen de FILM/TV-titel uit een poster/streamingscherm.

REGELS:
- Geen tekst over scan/foto/poster/camera.
- Als je het niet zeker weet: zet confidence laag en laat year/type leeg/unknown.
- Output: JSON en alleen JSON.`;

  const identifyUser = [
    {
      type: 'input_text',
      text:
        `Haal uit dit beeld de titel + (optioneel) jaartal en type.
` +
        `Return EXACT JSON:
` +
        `{
` +
        `  "title": string,
` +
        `  "year": number|null,
` +
        `  "type": "movie"|"tv"|"unknown",
` +
        `  "confidence": "low"|"medium"|"high"
` +
        `}
`,
    },
    {
      type: 'input_image',
      image_url: `data:${mimeType};base64,${imageBase64}`,
    },
  ];

  const idResp = await client.responses.create({
    model: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: identifySystem },
      { role: 'user', content: identifyUser },
    ],
    max_output_tokens: 250,
  });

  const idText = (idResp.output_text || '').trim();
  const identifiedRaw = safeJsonParse(idText) || {};
  const identified = {
    title: String(identifiedRaw.title || '').trim(),
    year: identifiedRaw.year ?? null,
    type: identifiedRaw.type || 'unknown',
    confidence: identifiedRaw.confidence || 'low',
  };

  // Fallback: if we couldn't identify, keep the old behavior (image-only "generic" analysis)
  
  // Cache hit: return stable output for the same film (calibration).
  const hasTitle = !!identified.title;
  const cacheKey = hasTitle ? `${_normKey(identified.title)}|${identified.year || ''}|${identified.type || 'unknown'}` : '';
  if (cacheKey) {
    const cached = _cacheGet(cacheKey);
    if (cached) {
      // Ensure identified reflects the current recognition (title/year/type)
      cached.identified = { ...(cached.identified || {}), ...identified };
      return OutputSchema.parse(cached);
    }
  }


  // --- 2) Web-based analysis (still ONLY OpenAI key; uses built-in web_search tool) ---
  const system = `
Je bent Unhyped: een onafhankelijke filmchecker.
Doel: in 30 seconden helderheid, zonder sterren en zonder hype.

BELANGRIJK:
- Je MOET web search gebruiken om publieke, niet-gesponsorde kijkerservaringen te vinden (reviews/discussies).
- Baseer mismatch/hype/influencers op wat er op het internet over deze film wordt gezegd.
- Geen tekst over scan/foto/poster/camera.
- Geen ChatGPT-symbolen zoals '-' of '•' in velden (jij levert tekst, UI maakt bullets).
- Geen plotspoilers.

METER SCORES (0-100):
- mismatch.score = kans op teleurstelling door verkeerde verwachting, gebaseerd op reviews ("verwachtte X, kreeg Y").
- hype.score = hoeveel hype/marketingdruk er rond de film lijkt (trending/most anticipated/media push).
- influencers.score = hoeveel influencer-achtige content rond de film aanwezig lijkt (TikTok/YouTube/IG mentions/reaction vids).
Gebruik conservatieve scores als je weinig bewijs vindt.

VERDICT:
- verdict.line exact: "Leuk als je X zoekt — maar verwacht geen Y" (X/Y kort, menselijk).

FILMSUMMARY:
- 2-3 zinnen, mensentaal.

AUDIENCE:
- worksFor (max 8) = voor wie deze film waarschijnlijk goed werkt.
- skipIf (max 8) = voor wie deze film waarschijnlijk NIET werkt.

VERWACHTINGSKLOOF:
- promise/reality/why: elk 1-3 zinnen.
- Dit moet echt gebaseerd zijn op publieke verwachtingen vs ervaringen.

OUTPUT:
- Geef STRICT JSON en alleen JSON, passend bij dit schema:
{
  "identified": { "title": string, "year": number|null, "type": "movie"|"tv"|"unknown", "confidence": "low"|"medium"|"high" },
  "filmSummary": string,
  "verdict": { "line": string, "bullets": [string, string, string] },
  "dashboard": {
    "mismatch": { "score": number, "level": "low"|"medium"|"high"|"unknown", "shortWhy": string },
    "hype": { "score": number, "level": "low"|"medium"|"high"|"unknown", "shortWhy": string },
    "influencers": { "score": number, "level": "low"|"medium"|"high"|"unknown", "shortWhy": string }
  },
  "worksFor": [string],
  "skipIf": [string],
  "expectationGap": { "promise": string, "reality": string, "why": string },
  "sources": [{ "title": string, "url": string }]
}
`;

  // If title is unknown, do a safe generic analysis without web-search claims.
  if (!hasTitle) {
    const generic = OutputSchema.parse({
      identified: { title: '', year: null, type: 'unknown', confidence: 'low' },
      filmSummary:
        'Onbekend welke film dit precies is. Het ziet eruit als een film/posterbeeld, maar ik kan de titel niet betrouwbaar lezen.',
      verdict: {
        line: 'Leuk als je iets in deze sfeer zoekt — maar verwacht geen precieze match',
        bullets: [
          'Maak een close-up van de titel voor betere herkenning.',
          'Zonder titel kan ik geen echte kijkerservaringen ophalen.',
          'De analyse hieronder is daarom algemeen en voorzichtig.',
        ],
      },
      dashboard: {
        mismatch: { score: 0, level: 'unknown', shortWhy: 'Titel onbekend: geen betrouwbare reviews gevonden.' },
        hype: { score: 0, level: 'unknown', shortWhy: 'Titel onbekend: geen betrouwbare hype-signalen te koppelen.' },
        influencers: { score: 0, level: 'unknown', shortWhy: 'Titel onbekend: geen betrouwbare influencer-signalen te koppelen.' },
      },
      worksFor: [],
      skipIf: [],
      expectationGap: { promise: '', reality: '', why: '' },
      sources: [],
    });
    return generic;
  }

  const title = identified.title;
  const yearPart = identified.year ? ` (${identified.year})` : '';
  const typePart = identified.type && identified.type !== 'unknown' ? identified.type : 'movie';

  const user = [
    {
      type: 'input_text',
      text:
        `Zoek op het web naar publieke kijkerservaringen, reviews en discussie over: "${title}"${yearPart}.
` +
        `Focus op: (1) verwachting vs werkelijkheid, (2) hype/marketingdruk, (3) influencer-achtige buzz.
` +
        `Gebruik meerdere bronnen (bijv. reviewsites, artikelen, fora).
` +
        `Schrijf in helder Nederlands, zonder spoilers.
` +
        `Return STRICT JSON volgens het schema uit de system prompt.`,
    },
  ];

  const resp = await client.responses.create({
    model: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources'],
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_output_tokens: 1100,
  });

  const text = (resp.output_text || '').trim();
  const parsed = safeJsonParse(text);

  // Extract web sources if present
  const sources = [];
  try {
    const outputs = resp.output || [];
    for (const item of outputs) {
      if (item.type === 'web_search_call' && item.action && Array.isArray(item.action.sources)) {
        for (const s of item.action.sources) {
          if (s && s.url) sources.push({ title: String(s.title || ''), url: String(s.url) });
        }
      }
    }
  } catch (_) {}

  // If parsing failed, still return a safe minimal output.
  if (!parsed) {
    return OutputSchema.parse({
      identified,
      filmSummary: `${title} lijkt een ${typePart}. Ik kon geen nette JSON-analyse terugkrijgen, maar de titel is wel herkend.`,
      verdict: { line: `Leuk als je ${title} zoekt — maar verwacht geen perfecte analyse`, bullets: [] },
      dashboard: {
        mismatch: { score: 0, level: 'unknown', shortWhy: 'Analyse mislukt.' },
        hype: { score: 0, level: 'unknown', shortWhy: 'Analyse mislukt.' },
        influencers: { score: 0, level: 'unknown', shortWhy: 'Analyse mislukt.' },
      },
      worksFor: [],
      skipIf: [],
      expectationGap: { promise: '', reality: '', why: '' },
      sources: sources.slice(0, 8),
    });
  }

  // Merge identified + sources (and coerce types)
  parsed.identified = { ...identified, ...(parsed.identified || {}) };
  parsed.sources = Array.isArray(parsed.sources) && parsed.sources.length ? parsed.sources : sources.slice(0, 8);


  // Attach sources (if AI already provided, keep those; else use extracted)
  parsed.sources = Array.isArray(parsed.sources) && parsed.sources.length ? parsed.sources : sources.slice(0, 8);

  // Coerce & calibrate meter scores for stability across runs
  const keyForCal = cacheKey || `${_normKey(identified.title)}|${identified.year || ''}|${identified.type || 'unknown'}`;
  if (parsed.dashboard) {
    if (parsed.dashboard.mismatch) parsed.dashboard.mismatch.score = _calibrateScore(keyForCal, parsed.dashboard.mismatch.score, 'mismatch');
    if (parsed.dashboard.hype) parsed.dashboard.hype.score = _calibrateScore(keyForCal, parsed.dashboard.hype.score, 'hype');
    if (parsed.dashboard.influencers) parsed.dashboard.influencers.score = _calibrateScore(keyForCal, parsed.dashboard.influencers.score, 'influencers');
  }

  const finalOut = OutputSchema.parse(parsed);

  // Cache for future stability
  if (cacheKey) _cacheSet(cacheKey, finalOut);

  return finalOut;
}


module.exports = {
  analyzeImageWithOpenAI,
};
