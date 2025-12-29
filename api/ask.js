// api/ask.js
// Vation AI Search POC - backend
// - Crawls a few public pages from siteBaseUrl
// - Sends a SMALL grounded snippet set to Gemini
// - Caches responses to reduce quota burn
// - Retry once on 429/5xx

const CACHE = new Map(); // in-memory (good enough for POC). Key => {ts, data}
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+(>|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickUrls(siteBaseUrl, preset) {
  const base = siteBaseUrl.replace(/\/+$/, "");
  const urls = {
    core: [
      `${base}/`,
      `${base}/solutions/`,
      `${base}/offerings/`,
    ],
    cx: [
      `${base}/solutions/customer-experience/`,
      `${base}/`,
    ],
    ex: [
      `${base}/solutions/employee-experience/`,
      `${base}/`,
    ],
  };
  return urls[preset] || urls.core;
}

async function fetchPageText(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (POC Bot; +https://vation.com)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
  const html = await r.text();
  const text = stripHtml(html);
  // Keep it small: take first ~4500 chars from each page (enough for Gemini)
  return text.slice(0, 4500);
}

function buildPrompt({ question, preset }) {
  // Hard cap answer size to protect quota + keep demo clean.
  // Also forces structure so it looks like Rightpoint-style.
  if (preset === "cx") {
    return `You are an AI website search assistant. Answer ONLY using the provided website excerpts.
Question: "What does Vation offer in Customer Experience (CX)?"
Output rules:
- Max 120 words total
- 1 short headline line, then exactly 5 bullet points
- If info is missing, say "Not stated on the provided pages" in that bullet.
Do not add external knowledge.`;
  }
  if (preset === "ex") {
    return `You are an AI website search assistant. Answer ONLY using the provided website excerpts.
Question: "What does Vation offer in Employee Experience (EX)?"
Output rules:
- Max 120 words total
- 1 short headline line, then exactly 5 bullet points
- If info is missing, say "Not stated on the provided pages" in that bullet.
Do not add external knowledge.`;
  }
  // core
  return `You are an AI website search assistant. Answer ONLY using the provided website excerpts.
User question: "${question}"
Output rules:
- Max 120 words total
- 1 short headline line, then exactly 5 bullet points
- No marketing fluff; keep it factual.
- Do not add external knowledge.`;
}

async function callGemini({ apiKey, model, prompt, sourcesText }) {
  // Google AI Studio (Generative Language API) style endpoint.
  // If your key is from AI Studio, this is typically correct.
  // Model should be one you see: e.g., "gemini-2.0-flash"
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
      maxOutputTokens: 220, // keeps output short and cheap
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
    const code = json?.error?.code || r.status;
    const err = new Error(msg);
    err.status = r.status;
    err.code = code;
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
    // Retry once for rate limit / transient errors
    const status = e?.status || 0;
    if (status === 429 || status >= 500) {
      await new Promise((r) => setTimeout(r, 1200));
      return await callGemini(args);
    }
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return safeJson(res, 405, { error: "Method not allowed. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return safeJson(res, 500, { error: "Missing GEMINI_API_KEY in Vercel environment variables." });
  }

  let body = {};
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return safeJson(res, 400, { error: "Invalid JSON body." });
  }

  const question = (body.question || "").trim();
  const siteBaseUrl = (body.siteBaseUrl || "https://vation.com").trim();
  const preset = (body.preset || "").trim().toLowerCase(); // "core" | "cx" | "ex"

  if (!question) {
    return safeJson(res, 400, { error: "Missing 'question'." });
  }

  // Use a model that you actually see in AI Studio
  // (You said you see Gemini 2.0 Flash / Flash Latest)
  const model = (body.model || "gemini-2.0-flash").trim();

  // Cache key: prevents repeated burn when you click buttons repeatedly
  const cacheKey = JSON.stringify({ question, siteBaseUrl, preset, model });
  const cached = cacheGet(cacheKey);
  if (cached) {
    return safeJson(res, 200, { ...cached, cached: true });
  }

  // Pick a SMALL set of pages to keep quota low
  const urls = pickUrls(siteBaseUrl, preset || "core");

  let sources = [];
  try {
    const texts = await Promise.all(
      urls.map(async (u) => {
        const t = await fetchPageText(u);
        return { url: u, text: t };
      })
    );

    // Build compact “sourcesText” for Gemini
    const sourcesText = texts
      .map((p, i) => `SOURCE ${i + 1}: ${p.url}\n${p.text}\n`)
      .join("\n")
      .slice(0, 12000); // hard cap total input text

    const prompt = buildPrompt({ question, preset });

    const answer = await callGeminiWithRetry({
      apiKey,
      model,
      prompt,
      sourcesText,
    });

    sources = texts.map((t) => ({ title: t.url, url: t.url }));

    const payload = { answer, sources, model, preset: preset || "core" };
    cacheSet(cacheKey, payload);
    return safeJson(res, 200, payload);
  } catch (e) {
    // Do NOT show weak messages. Keep it professional for demo.
    const status = e?.status || 500;
    const code = e?.code || status;
    const msg = (e?.message || "").toString();

    // If Gemini is rate-limited, return a crisp directive (not apologetic).
    if (status === 429 || String(code).includes("429")) {
      return safeJson(res, 200, {
        answer:
          "The AI is currently throttled by the model provider for this key. Please retry once after ~30 seconds, or switch to a fresh API key for the demo run.",
        sources: urls.map((u) => ({ title: u, url: u })),
        model,
        preset: preset || "core",
        error: { code: 429, message: "Rate limited" },
      });
    }

    return safeJson(res, 200, {
      answer:
        "AI summary could not be generated for this request. Please retry, or confirm the model name and API key permissions in Google AI Studio.",
      sources: urls.map((u) => ({ title: u, url: u })),
      model,
      preset: preset || "core",
      error: { code, message: msg || "Unknown error" },
    });
  }
}
