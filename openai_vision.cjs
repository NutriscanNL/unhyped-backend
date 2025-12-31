// openai_vision.cjs
// OpenAI Responses API (Vision) -> returns JSON describing the title/year/platform hint.
//
// NOTE (Dec 2025): `response_format` is deprecated in Responses API.
// Use `text.format` instead.

const OPENAI_URL = "https://api.openai.com/v1/responses";

function toDataUrl(mime, base64) {
  return `data:${mime};base64,${base64}`;
}

function extractOutputText(data) {
  if (data && typeof data.output_text === "string" && data.output_text.length) return data.output_text;

  const out = data?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        const t = content.find(c => c?.type === "output_text" && typeof c.text === "string");
        if (t?.text) return t.text;
        const t2 = content.find(c => typeof c?.text === "string");
        if (t2?.text) return t2.text;
      }
    }
  }
  throw new Error("OpenAI response missing output text");
}

async function identifyFromImage({ apiKey, model, imageBase64, mimeType }) {
  const prompt = `
You are Unhyped's identifier.
Goal: Identify the film or series shown in the screenshot/photo.

Return ONLY strict JSON with this shape:
{
  "title": string | null,
  "year": number | null,
  "type": "movie" | "tv" | "unknown",

  "platform_hint": string | null,        // e.g., "Netflix", "Prime Video", "Disney+", "Apple TV", "HBO Max", "Pathé"
  "platform_confidence": "high" | "medium" | "low",

  "confidence": "high" | "medium" | "low",
  "notes": string | null,

  "signals": {
    "visible_service_ui": boolean,
    "language_hint": string | null
  }
}

Rules:
- If unsure: set fields to null and confidence="low".
- Prefer the visible title on screen/poster.
- If multiple candidates: pick the most prominent.
- "platform_hint" MUST be based only on visible cues in the image (logos/UI/text).
`;

  const body = {
    model: model || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          {
            type: "input_image",
            image_url: toDataUrl(mimeType, imageBase64),
            detail: "low"
          }
        ]
      }
    ],
    // ✅ New way to request JSON output in Responses API:
    text: { format: { type: "json_object" } }
  };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t}`);
  }

  const data = await res.json();
  const text = extractOutputText(data);

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse OpenAI JSON: ${text}`);
  }
}

module.exports = { identifyFromImage };
