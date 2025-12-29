// api/ask.js — DEMO SAFE VERSION
// Purpose: Always reach Gemini, even if some pages fail

const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function now() {
  return Date.now();
}

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (now() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  CACHE.set(key, { ts: now(), data });
}

function safeJson(res, status, obj) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function stripHtml(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickUrls(siteBaseUrl, preset) {
  const base = siteBaseUrl.replace(/\/+$/, "");
  return {
    core: [`${base}/solutions/`, `${base}/offerings/`],
    cx: [`${base}/solutions/customer-experience/`],
    ex: [`${base}/solutions/employee-experience/`],
  }[preset] || [`${base}/solutions/`];
}

async function fetchPageText(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 DemoBot" },
    });
    if (!r.ok) return null;
    const html = await r.text();
    return stripHtml(html).slice(0, 3500);
  } catch {
    return null;
  }
}

function buildPrompt(preset) {
  const map = {
    core: `In max 120 words:
Give 1 short summary line + exactly 5 bullet points explaining what Vation does.
Use ONLY the provided website text.`,

    cx: `In max 120 words:
Summarize Vation’s Customer Experience (CX) capabilities.
Format:
• 1 summary line
• Exactly 5 bullets
Use ONLY the provided website text.`,

    ex: `In max 120 words:
Summarize Vation’s Employee Experience (EX) capabilities.
Format:
• 1 summary line
• Exactly 5 bullets
Use ONLY the provided website text.`,
  };
  return map[preset] || map.core;
}

async function callGemini({ apiKey, model, prompt, sourcesText }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${prompt}\n\nWEBSITE CONTENT:\n${sourcesText}` }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 220,
    },
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await r.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return safeJson(res, 405, { error: "POST only" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return safeJson(res, 500, { error: "Missing GEMINI_API_KEY" });
  }

  const { siteBaseUrl = "https://vation.com", preset = "core" } =
    typeof req.body === "string" ? JSON.parse(req.body) : req.body;

  const model = "gemini-2.0-flash";
  const cacheKey = `${preset}-${model}`;

  const cached = cacheGet(cacheKey);
  if (cached) return safeJson(res, 200, cached);

  const urls = pickUrls(siteBaseUrl, preset);
  const pages = await Promise.all(urls.map(fetchPageText));
  const validPages = pages.filter(Boolean);

  if (validPages.length === 0) {
    return safeJson(res, 200, {
      answer:
        "Content is temporarily unavailable for summarization. Please refer to the listed source pages.",
      sources: urls.map((u) => ({ url: u })),
      preset,
    });
  }

  const sourcesText = validPages.join("\n\n").slice(0, 8000);
  const prompt = buildPrompt(preset);

  const answer = await callGemini({
    apiKey,
    model,
    prompt,
    sourcesText,
  });

  const payload = {
    answer:
      answer ||
      "The AI response could not be generated at this moment. Please retry once.",
    sources: urls.map((u) => ({ url: u })),
    model,
    preset,
  };

  cacheSet(cacheKey, payload);
  return safeJson(res, 200, payload);
}
