// /api/ask.js
export default async function handler(req, res) {
  // ---- CORS (so browser fetch tests don't explode) ----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { question, siteBaseUrl } = req.body || {};
    const q = (question || "").trim();
    const base = (siteBaseUrl || "").trim();

    if (!q || !base) {
      return res.status(400).json({ error: "Missing question or siteBaseUrl" });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY in Vercel env" });
    }

    // Prefer what you actually see in AI Studio
    const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    // ---- Choose 1-2 most relevant pages ONLY (cheap) ----
    const { targets, label } = pickTargets(q, base);

    // ---- Fetch only those pages ----
    const pages = [];
    for (const url of targets) {
      const html = await safeFetchText(url);
      if (html) {
        pages.push({
          url,
          text: extractUsefulText(html, 5500) // cap raw text per page
        });
      }
    }

    // Build minimal context
    const sources = pages.map(p => ({ url: p.url }));
    const contextBlock = pages
      .map((p, i) => `SOURCE ${i + 1}: ${p.url}\n${p.text}`)
      .join("\n\n");

    // ---- Strict, small-output prompt ----
    const maxWords = 120;
    const prompt = [
      `You are an AI website search assistant for Vation.`,
      `Task: Answer the user question using ONLY the sources provided.`,
      `Output rules:`,
      `- Max ${maxWords} words total.`,
      `- Use simple business language.`,
      `- If info is not in sources, say: "Not found on the provided pages."`,
      `- Do NOT mention tokens, rate limits, or internal errors.`,
      ``,
      `User question: ${normalizeQuestion(q, label)}`,
      ``,
      `Sources:\n${contextBlock}`
    ].join("\n");

    // ---- Gemini call ----
    const geminiResponse = await callGemini({
      apiKey: GEMINI_API_KEY,
      model: MODEL,
      prompt
    });

    // Final guard: hard-trim to word limit (still "Gemini answer" but capped)
    const answer = enforceWordLimit(geminiResponse || "", maxWords) || "Not found on the provided pages.";

    return res.status(200).json({ answer, sources });
  } catch (err) {
    // Strong fallback (no "weak" message)
    return res.status(200).json({
      answer:
        "I couldn’t generate a grounded summary right now. Please try again once. If it repeats, it’s likely an API configuration or rate limit issue.",
      sources: []
    });
  }
}

/* ---------------- Helpers ---------------- */

function pickTargets(question, base) {
  const q = question.toLowerCase();

  // 3 curated intents: Core / CX / EX (you asked exactly this)
  if (q.includes("customer experience") || q.includes(" cx ") || q.includes("cx")) {
    return {
      label: "CX",
      targets: [
        joinUrl(base, "/solutions/customer-experience/"),
        joinUrl(base, "/") // home as backup
      ]
    };
  }
  if (q.includes("employee experience") || q.includes(" ex ") || q.includes("ex")) {
    return {
      label: "EX",
      targets: [
        joinUrl(base, "/solutions/employee-experience/"),
        joinUrl(base, "/") // home as backup
      ]
    };
  }

  // Core offerings
  return {
    label: "CORE",
    targets: [
      joinUrl(base, "/"),
      joinUrl(base, "/solutions/") // if exists, great; if 404, it's ok
    ]
  };
}

function normalizeQuestion(q, label) {
  // Force concise questions (prevents users typing essays)
  if (label === "CX") return "Summarize Vation’s Customer Experience (CX) capabilities in 5 bullet points.";
  if (label === "EX") return "Summarize Vation’s Employee Experience (EX) capabilities in 5 bullet points.";
  return "Summarize Vation’s core offerings in 5 bullet points.";
}

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function safeFetchText(url) {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok) return "";
    const t = await r.text();
    return t || "";
  } catch {
    return "";
  }
}

function extractUsefulText(html, maxChars = 6000) {
  // remove scripts/styles
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/?(?:svg|path|img|video|audio|canvas)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // keep only first N chars to stay cheap
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

async function callGemini({ apiKey, model, prompt }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 220 // small output cap
    }
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    // throw to fallback handler
    throw new Error(`Gemini HTTP ${r.status}`);
  }

  const json = await r.json();
  const txt =
    json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ||
    "";
  return (txt || "").trim();
}

function enforceWordLimit(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return words.slice(0, maxWords).join(" ") + "…";
}
