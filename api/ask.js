// api/ask.js
// OmniOne / Vation AI Search POC
// Gemini-only summarization (NO hardcoded answers)
// Ultra-low quota design for demos

const CACHE = new Map();
const TTL = 5 * 60 * 1000; // 5 min cache

function json(res, code, data) {
  res.status(code).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function strip(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchPage(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "OmniOne-POC" },
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  return strip(await r.text()).slice(0, 3500); // HARD CAP
}

function buildPrompt(preset) {
  switch (preset) {
    case "cx":
      return `Summarize Vation's Customer Experience services.
Rules:
- Max 80 words
- Clear business language
- No assumptions
- Use only provided content`;

    case "ex":
      return `Summarize Vation's Employee Experience services.
Rules:
- Max 80 words
- Clear business language
- No assumptions
- Use only provided content`;

    default:
      return `In max 80 words, explain what Vation does as a company.
Rules:
- Clear, factual
- No marketing fluff
- Use only provided content`;
  }
}

async function callGemini({ apiKey, prompt, content }) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" +
    apiKey;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${prompt}\n\nCONTENT:\n${content}` }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 160,
    },
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "Gemini error");

  return (
    j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    ""
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return json(res, 405, { error: "POST only" });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return json(res, 500, { error: "Missing GEMINI_API_KEY" });

  const { preset = "core", siteBaseUrl = "https://vation.com" } =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  const cacheKey = preset;
  if (CACHE.has(cacheKey)) {
    const hit = CACHE.get(cacheKey);
    if (Date.now() - hit.ts < TTL)
      return json(res, 200, { ...hit.data, cached: true });
  }

  try {
    const pageMap = {
      core: `${siteBaseUrl}/`,
      cx: `${siteBaseUrl}/solutions/customer-experience/`,
      ex: `${siteBaseUrl}/solutions/employee-experience/`,
    };

    const pageUrl = pageMap[preset] || pageMap.core;
    const content = await fetchPage(pageUrl);
    const prompt = buildPrompt(preset);

    const answer = await callGemini({
      apiKey,
      prompt,
      content,
    });

    const payload = {
      answer,
      sources: [{ title: pageUrl, url: pageUrl }],
      model: "gemini-2.0-flash",
      preset,
    };

    CACHE.set(cacheKey, { ts: Date.now(), data: payload });
    return json(res, 200, payload);
  } catch (e) {
    return json(res, 200, {
      answer:
        "Gemini could not generate a response for this request. Please retry with a fresh API key.",
      sources: [],
      error: e.message,
    });
  }
}
