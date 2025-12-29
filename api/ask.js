// api/ask.js
// OmniOne / Vation AI Search POC - backend (Vercel)
// - Fetches a few public pages from siteBaseUrl (different for core/cx/ex)
// - Sends SMALL grounded excerpts to Gemini (cheap, fast)
// - Forces short output: 1 line + 5 bullets (~<=120 words)
// - Handles CORS + OPTIONS (Tampermonkey friendly)
// - Retries once on 429/5xx
// - In-memory cache (POC)

const CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

function now() { return Date.now(); }

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (now() - hit.ts > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) { CACHE.set(key, { ts: now(), data }); }

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function safeJson(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

function detectPreset(question = "", preset = "") {
  const p = (preset || "").toLowerCase().trim();
  if (p === "cx" || p === "ex" || p === "core") return p;

  const q = (question || "").toLowerCase();
  if (q.includes("customer experience") || /\bcx\b/.test(q)) return "cx";
  if (q.includes("employee experience") || /\bex\b/.test(q)) return "ex";
  return "core";
}

function pickUrls(siteBaseUrl, preset) {
  const base = (siteBaseUrl || "https://vation.com").replace(/\/+$/, "");

  // Keep it SMALL for quota control.
  // You can add more URLs later once the team takes over.
  const urlsByPreset = {
    core: [
      `${base}/`,
      `${base}/solutions/`,
      `${base}/offerings/`,
    ],
    cx: [
      `${base}/solutions/customer-experience/`,
      `${base}/solutions/`,
    ],
    ex: [
      `${base}/solutions/employee-experience/`,
      `${base}/solutions/`,
    ],
  };

  return urlsByPreset[preset] || urlsByPreset.core;
}

async function fetchPageText(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (OmniOne POC Bot)",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });

    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    const html = await r.text();
    const text = stripHtml(html);

    // Keep each page VERY small and cheap.
    // (This is the #1 lever to reduce quota burn.)
    return text.slice(0, 2600);
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt({ preset, userQuestion }) {
  // Hard rule: short outputs only (prevents quota burn).
  // Also force structure so it looks “product-grade” in demo.
  const baseRules = `
You are an AI website search assistant.
You MUST answer ONLY using the WEBSITE EXCERPTS provided.
If something is not present in excerpts, say: "Not stated on the provided pages."

Output format rules (STRICT):
- Max 120 words total
- First line: 1 short headline sentence
- Then exactly 5 bullets (start each bullet with "- ")
- No extra sections, no links in the answer
- No marketing fluff, keep it factual
`;

  if (preset === "cx") {
    return `${baseRules}
User question: "Summarize Vation's Customer Experience (CX) capabilities."
`;
  }

  if (preset === "ex") {
    return `${baseRules}
User question: "Summarize Vation's Employee Experience (EX) capabilities."
`;
  }

  return `${baseRules}
User question: "${userQuestion}"
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
              `WEBSITE EXCERPTS (GROUND TRUTH):\n` +
              sourcesText,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      // Keep output short and cheap:
      maxOutputTokens: 180,
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
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      return await callGemini(args);
    }
    throw e;
  }
}

export default async function handler(req, res) {
  setCors(res);

  // OPTIONS preflight for browser/Tampermonkey
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return safeJson(res, 405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return safeJson(res, 500, { error: "Missing GEMINI_API_KEY in Vercel env vars." });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return safeJson(res, 400, { error: "Invalid JSON body." });
  }

  const question = (body.question || "").trim();
  const siteBaseUrl = (body.siteBaseUrl || "https://vation.com").trim();

  if (!question) return safeJson(res, 400, { error: "Missing 'question'." });

  // Use a model that exists in AI Studio for you.
  // If you see "Gemini 2.0 Flash" / "Flash latest", this is the safest default:
  const model = (body.model || "gemini-2.0-flash").trim();

  const preset = detectPreset(question, body.preset);
  const urls = pickUrls(siteBaseUrl, preset);

  // Cache prevents repeated cli
