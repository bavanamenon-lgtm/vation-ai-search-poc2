// api/ask.js
// OmniOne / Vation AI Search POC - backend (Vercel Serverless)
//
// Fixes:
// 1) Robust website fetching: tries https://www. + trailing-slash fallback
// 2) Auto-detect preset (cx/ex/core) from question even if frontend doesn't send preset
// 3) Works even if one of the pages fails: uses whatever it can fetch
// 4) Keeps Gemini output short to protect quota
// 5) Adds clean CORS + OPTIONS support for injected UI

const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

const FETCH_TIMEOUT_MS = 9000; // keep snappy for demo
const MAX_PAGE_CHARS = 4500;   // per page
const MAX_SOURCES_TEXT = 12000; // total prompt grounding

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

function sendJson(res, status, obj) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");

  // CORS (needed for injected UI / browser calls)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.end(JSON.stringify(obj));
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBaseUrl(siteBaseUrl) {
  // Prefer www to avoid weird 404 behaviors
  let base = (siteBaseUrl || "https://vation.com").trim();
  base = base.replace(/\/+$/, ""); // remove trailing slash
  if (base === "vation.com") base = "https://vation.com";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;

  // If it's vation.com (no www), we still try it first, but we will fallback to www in fetch
  return base;
}

function withTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function toWww(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.startsWith("www.")) u.hostname = `www.${u.hostname}`;
    return u.toString().replace(/\/+$/, ""); // normalize
  } catch {
    return url;
  }
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function fetchPageTextRobust(url) {
  const headers = {
    // More realistic UA reduces bot-block weirdness
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const attempts = [];
  const u1 = url;
  const u2 = withTrailingSlash(url);
  const u3 = toWww(url);
  const u4 = withTrailingSlash(u3);

  // de-dupe while preserving order
  for (const u of [u1, u2, u3, u4]) {
    if (u && !attempts.includes(u)) attempts.push(u);
  }

  let lastErr = null;

  for (const u of attempts) {
    try {
      const r = await fetchWithTimeout(u, { method: "GET", headers });
      if (!r.ok) {
        lastErr = new Error(`Fetch failed ${r.status} for ${u}`);
        continue;
      }
      const html = await r.text();
      const text = stripHtml(html).slice(0, MAX_PAGE_CHARS);
      if (text.length < 50) {
        lastErr = new Error(`Fetch returned too little text for ${u}`);
        continue;
      }
      return { finalUrl: u, text };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error(`Fetch failed for ${url}`);
}

function detectPreset(question, explicitPreset) {
  const p = (explicitPreset || "").trim().toLowerCase();
  if (p === "cx" || p === "ex" || p === "core") return p;

  const q = (question || "").toLowerCase();
  if (q.startsWith("cx:") || q.includes("customer experience") || q.includes("cx capabilities")) return "cx";
  if (q.startsWith("ex:") || q.includes("employee experience") || q.includes("ex capabilities")) return "ex";
  return "core";
}

function pickUrls(base, preset) {
  const b = base.replace(/\/+$/, "");

  // Keep page count LOW to reduce failure + quota burn
  if (preset === "cx") {
    return [
      `${b}/solutions/customer-experience/`,
      `${b}/solutions/`,
    ];
  }
  if (preset === "ex") {
    return [
      `${b}/solutions/employee-experience/`,
      `${b}/solutions/`,
    ];
  }
  // core
  return [
    `${b}/`,
    `${b}/solutions/`,
    `${b}/offerings/`,
  ];
}

function buildPrompt(preset, question) {
  if (preset === "cx") {
    return `
You are an AI website search assistant for Vation.
Answer ONLY using the WEBSITE EXCERPTS provided below (do not use external knowledge).

Task: Summarize Vation's Customer Experience (CX) capabilities.

Format rules:
- Max 120 words TOTAL
- 1 short headline line (<= 12 words)
- Exactly 5 bullet points
- If something is not stated in excerpts, write "Not stated" for that bullet.
`;
  }

  if (preset === "ex") {
    return `
You are an AI website search assistant for Vation.
Answer ONLY using the WEBSITE EXCERPTS provided below (do not use external knowledge).

Task: Summarize Vation's Employee Experience (EX) capabilities.

Format rules:
- Max 120 words TOTAL
- 1 short headline line (<= 12 words)
- Exactly 5 bullet points
- If something is not stated in excerpts, write "Not stated" for that bullet.
`;
  }

  return `
You are an AI website search assistant for Vation.
Answer ONLY using the WEBSITE EXCERPTS provided below (do not use external knowledge).

User question: "${question}"

Format rules:
- Max 120 words TOTAL
- 1 short headline line (<= 12 words)
- Exactly 5 bullet points
- No fluff.
`;
}

async function callGemini({ apiKey, model, prompt, sourcesText }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `${prompt}\n\n` +
              `WEBSITE EXCERPTS (ground truth):\n` +
              sourcesText,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 220, // short + cheap
    },
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `Gemini HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.code = json?.error?.code || r.status;
    throw err;
  }

  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() || "";

  if (!text) throw new Error("Empty Gemini response");
  return text;
}

async function callGeminiWithRetry(args) {
  try {
    return await callGemini(args);
  } catch (e) {
    const status = e?.status || 0;
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      return await callGemini(args);
    }
    throw e;
  }
}

export default async function handler(req, res) {
  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return sendJson(res, 405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, { error: "Missing GEMINI_API_KEY in Vercel env vars." });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body." });
  }

  const question = (body.question || "").trim();
  if (!question) return sendJson(res, 400, { error: "Missing 'question'." });

  const siteBaseUrl = normalizeBaseUrl(body.siteBaseUrl || "https://vation.com");
  const preset = detectPreset(question, body.preset);

  // Use a model you actually have in AI Studio.
  // Keep default to 2.0 Flash (most common)
  const model = (body.model || "gemini-2.0-flash").trim();

  const cacheKey = JSON.stringify({ question, siteBaseUrl, preset, model });
  const cached = cacheGet(cacheKey);
  if (cached) return sendJson(res, 200, { ...cached, cached: true });

  const urls = pickUrls(siteBaseUrl, preset);

  try {
    // Fetch pages one by one so a single failure doesn't kill the demo
    const texts = [];
    for (const u of urls) {
      try {
        const page = await fetchPageTextRobust(u);
        texts.push({ url: page.finalUrl, text: page.text });
      } catch (e) {
        // Skip failed page; continue
      }
    }

    if (!texts.length) {
      // This is the REAL root cause you're facing — no website text fetched.
      return sendJson(res, 200, {
        answer:
          "No public page content could be fetched from the website right now (blocked/404). Switch the base URL to https://www.vation.com or try again.",
        sources: urls.map((u) => ({ title: u, url: u })),
        model,
        preset,
        error: { code: "FETCH_FAILED", message: "No sources fetched" },
      });
    }

    const sourcesText = texts
      .map((p, i) => `SOURCE ${i + 1}: ${p.url}\n${p.text}\n`)
      .join("\n")
      .slice(0, MAX_SOURCES_TEXT);

    const prompt = buildPrompt(preset, question);

    const answer = await callGeminiWithRetry({
      apiKey,
      model,
      prompt,
      sourcesText,
    });

    const sources = texts.map((t) => ({ title: t.url, url: t.url }));
    const payload = { answer, sources, model, preset };

    cacheSet(cacheKey, payload);
    return sendJson(res, 200, payload);
  } catch (e) {
    const status = e?.status || 500;
    const code = e?.code || status;
    const msg = (e?.message || "").toString();

    // Keep demo-safe messaging (no 404/429 scary junk)
    return sendJson(res, 200, {
      answer:
        "AI summary could not be generated for this request right now. Use model 'gemini-2.0-flash' and ensure the API key is active.",
      sources: urls.map((u) => ({ title: u, url: u })),
      model,
      preset,
      error: { code, message: msg || "Unknown error" },
    });
  }
}
