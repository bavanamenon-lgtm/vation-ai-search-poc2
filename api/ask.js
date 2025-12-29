// api/ask.js
// OmniOne / Vation AI Search POC - backend
// Goals:
// - Always use Gemini (no hardcoded answers)
// - Keep token usage low (short excerpts + short outputs)
// - Avoid "wrong model" failures by auto-selecting a valid model for the key/project
// - No Tampermonkey changes required: auto-detect preset (core/cx/ex) from the question text
// - Cache responses to reduce quota burn

const CACHE = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Cache for model list resolution per cold start
let MODEL_CACHE = {
  ts: 0,
  models: null,
};

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
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  // CORS (important when calling from vation.com via your overlay)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-goog-api-key");
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
  const base = (siteBaseUrl || "https://vation.com").trim();
  return base.replace(/\/+$/, "");
}

function pickUrls(siteBaseUrl, preset) {
  const base = normalizeBaseUrl(siteBaseUrl);

  const urls = {
    core: [
      `${base}/`,
      `${base}/solutions/`,
      `${base}/offerings/`,
    ],
    cx: [
      `${base}/solutions/customer-experience/`,
      `${base}/solutions/`, // small helper page
    ],
    ex: [
      `${base}/solutions/employee-experience/`,
      `${base}/solutions/`, // small helper page
    ],
    ai: [
      `${base}/`, // if you later add a dedicated AI page, add it here
      `${base}/solutions/`,
    ],
  };

  return urls[preset] || urls.core;
}

// Auto-detect preset from question so you don't need to modify Tampermonkey
function detectPreset(questionRaw) {
  const q = (questionRaw || "").toLowerCase();

  // Explicit tags people type
  if (q.startsWith("cx:") || q.includes("customer experience") || /\bcx\b/.test(q)) return "cx";
  if (q.startsWith("ex:") || q.includes("employee experience") || /\bex\b/.test(q)) return "ex";
  if (q.includes("how does vation use ai") || q.includes("vation use ai") || q.includes("knowledge ai")) return "ai";

  // Default
  return "core";
}

async function fetchPageText(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (OmniOne POC; +https://vation.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });

  if (!r.ok) {
    throw new Error(`Fetch failed ${r.status} for ${url}`);
  }

  const html = await r.text();
  const text = stripHtml(html);

  // Keep input small to reduce quota burn
  return text.slice(0, 2800);
}

function buildPrompt({ question, preset }) {
  // Force short answer + structure (Rightpoint-style)
  // IMPORTANT: don’t make prompt huge; prompt tokens also cost
  const commonRules = `Answer ONLY using the WEBSITE EXCERPTS provided. Do not use external knowledge.
Output format:
- Max 120 words total
- 1 short headline line
- Exactly 5 bullet points
If something is not stated, write "Not stated on the provided pages."`;

  if (preset === "cx") {
    return `You are a website-grounded assistant.
Task: Summarize Vation's Customer Experience (CX) capabilities.
${commonRules}`;
  }

  if (preset === "ex") {
    return `You are a website-grounded assistant.
Task: Summarize Vation's Employee Experience (EX) capabilities.
${commonRules}`;
  }

  if (preset === "ai") {
    return `You are a website-grounded assistant.
Task: Explain how Vation uses AI (only if stated on provided pages).
${commonRules}`;
  }

  // core
  return `You are a website-grounded assistant.
User question: "${question}"
${commonRules}`;
}

// ---- Gemini helpers ----

// Uses listModels to avoid "404 model not found" surprises
async function listModels(apiKey) {
  // cache for 10 minutes per cold start
  if (MODEL_CACHE.models && now() - MODEL_CACHE.ts < 10 * 60 * 1000) {
    return MODEL_CACHE.models;
  }

  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
  const r = await fetch(endpoint, {
    method: "GET",
    headers: {
      "x-goog-api-key": apiKey,
    },
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `listModels HTTP ${r.status}`;
    throw new Error(msg);
  }

  const models = (json?.models || [])
    .map((m) => m?.name)
    .filter(Boolean); // e.g. "models/gemini-2.5-flash"

  MODEL_CACHE = { ts: now(), models };
  return models;
}

function chooseBestModel(availableModelNames, requestedModel) {
  // Convert "models/gemini-2.5-flash" -> "gemini-2.5-flash"
  const avail = new Set(
    (availableModelNames || []).map((n) => n.replace(/^models\//, ""))
  );

  // If user requested a model and it exists, use it
  if (requestedModel && avail.has(requestedModel)) return requestedModel;

  // Prefer these, in order (cheap + fast)
  const preferred = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-latest",
    "gemini-2.0-flash",
    "gemini-2.0-flash-latest",
  ];

  for (const m of preferred) {
    if (avail.has(m)) return m;
  }

  // Fallback: pick any "flash" model
  for (const m of avail) {
    if (String(m).includes("flash")) return m;
  }

  // Last resort: first available
  return Array.from(avail)[0] || "gemini-2.5-flash";
}

async function callGemini({ apiKey, model, prompt, sourcesText }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;

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
      // Keep output short + cheap
      maxOutputTokens: 220,
    },
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
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
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() ||
    "";

  if (!text) throw new Error("Empty Gemini response");
  return text;
}

async function callGeminiWithRetry(args) {
  try {
    return await callGemini(args);
  } catch (e) {
    const status = e?.status || 0;
    // retry once for transient issues
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      return await callGemini(args);
    }
    throw e;
  }
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    return safeJson(res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return safeJson(res, 405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return safeJson(res, 500, {
      error: "Missing GEMINI_API_KEY in Vercel environment variables.",
    });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return safeJson(res, 400, { error: "Invalid JSON body." });
  }

  const question = (body.question || "").trim();
  const siteBaseUrl = normalizeBaseUrl(body.siteBaseUrl || "https://vation.com");

  if (!question) {
    return safeJson(res, 400, { error: "Missing 'question'." });
  }

  // If preset not provided by frontend, detect it from question text
  const preset = (body.preset || detectPreset(question)).toLowerCase();

  // Resolve a model that actually exists for THIS key/project
  let model = (body.model || "").trim();
  try {
    const models = await listModels(apiKey);
    model = chooseBestModel(models, model);
  } catch {
    // If listModels fails, still attempt a sane default
    model = model || "gemini-2.5-flash";
  }

  const cacheKey = JSON.stringify({ question, siteBaseUrl, preset, model });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return safeJson(res, 200, { ...cached, cached: true });
  }

  const urls = pickUrls(siteBaseUrl, preset);

  try {
    const pages = await Promise.all(
      urls.map(async (u) => {
        const text = await fetchPageText(u);
        return { url: u, text };
      })
    );

    const sourcesText = pages
      .map((p, i) => `SOURCE ${i + 1}: ${p.url}\n${p.text}\n`)
      .join("\n")
      .slice(0, 9000); // hard cap input

    const prompt = buildPrompt({ question, preset });

    const answer = await callGeminiWithRetry({
      apiKey,
      model,
      prompt,
      sourcesText,
    });

    const sources = pages.map((p) => ({ title: p.url, url: p.url }));
    const payload = { answer, sources, model, preset };

    cacheSet(cacheKey, payload);
    return safeJson(res, 200, payload);
  } catch (e) {
    // Don’t show “weak” text. Keep it crisp.
    // Also return real error info for YOU (console/logs) but UI can ignore it.
    const status = e?.status || 500;
    const code = e?.code || status;
    const msg = String(e?.message || "Unknown error");

    return safeJson(res, 200, {
      answer:
        "AI response was not generated. For demo reliability: refresh once and run the same question again.",
      sources: urls.map((u) => ({ title: u, url: u })),
      model,
      preset,
      error: { code, message: msg },
    });
  }
}
