// api/ask.js
// Vation AI Search POC - Gemini grounded summarizer with tight quota controls

export default async function handler(req, res) {
  // --- CORS (so browser fetch also works if needed later) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { question, siteBaseUrl } = req.body || {};
    if (!question || !siteBaseUrl) {
      return res.status(400).json({ error: "Missing question or siteBaseUrl" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Server missing GEMINI_API_KEY" });
    }

    // Pick a model that your key actually supports.
    // You said AI Studio shows “Gemini 2.0 Flash / Flash latest” etc.
    // So default to gemini-2.0-flash unless you override with env.
    const model =
      process.env.GEMINI_MODEL ||
      "gemini-2.0-flash";

    // Hard caps to avoid burning quota
    const MAX_PAGES = 4;              // keep small
    const MAX_CHARS_PER_PAGE = 2200;  // keep small
    const MAX_OUTPUT_TOKENS = 220;    // ~150-180 words max
    const REQUEST_TIMEOUT_MS = 12000;

    // 1) Fetch a small set of useful pages (cheap “site index”)
    // Keep it deterministic and small: homepage + CX + EX + About/Culture.
    const candidatePaths = [
      "/",
      "/solutions/customer-experience/",
      "/solutions/employee-experience/",
      "/about-vation/",
      "/our-culture/",
    ];

    const pages = [];
    for (const p of candidatePaths) {
      if (pages.length >= MAX_PAGES) break;
      const url = new URL(p, siteBaseUrl).toString();
      const text = await fetchPageText(url, REQUEST_TIMEOUT_MS);
      if (text) {
        pages.push({
          url,
          title: guessTitle(text) || url,
          snippet: text.slice(0, MAX_CHARS_PER_PAGE),
        });
      }
    }

    // If we couldn’t fetch anything, fail cleanly.
    if (!pages.length) {
      return res.status(200).json({
        answer:
          "I couldn’t fetch public content from the website right now. Please try again or check if the site is blocking automated access.",
        sources: [],
      });
    }

    // 2) Build a very tight prompt (forces word cap + bullets)
    const systemInstruction =
      "You are a website-grounded assistant. Use ONLY the provided page snippets as evidence. " +
      "Do not invent details. If something is not in the snippets, say 'Not stated on the provided pages.'";

    const userInstruction =
      "Answer the user question using ONLY the snippets.\n" +
      "Output format:\n" +
      "- First line: 1-sentence direct answer.\n" +
      "- Then: 5 bullet points (short).\n" +
      "- Word limit: 120 words max.\n\n" +
      `Question: ${question}\n\n` +
      "Snippets:\n" +
      pages
        .map((p, i) => `[#${i + 1}] ${p.url}\n${p.snippet}\n`)
        .join("\n");

    // 3) Call Gemini with ONE retry (so demo gets at least one success)
    const geminiResponse = await callGeminiWithRetry({
      apiKey,
      model,
      systemInstruction,
      userInstruction,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retries: 1, // important
    });

    // If Gemini still fails, return a strong message (no “weak” wording)
    if (!geminiResponse.ok) {
      return res.status(200).json({
        answer:
          "The AI service is busy right now. Please try again in 30 seconds. (This is a temporary quota/traffic limit.)",
        sources: pages.map((p) => ({ title: p.title, url: p.url })),
      });
    }

    return res.status(200).json({
      answer: geminiResponse.text,
      sources: pages.map((p) => ({ title: p.title, url: p.url })),
      modelUsed: model,
    });
  } catch (err) {
    return res.status(200).json({
      answer:
        "Something went wrong while generating the answer. Please retry once.",
      sources: [],
      debug: String(err?.message || err),
    });
  }
}

async function fetchPageText(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    const r = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; VationSearchPOC/1.0; +https://vation.com)",
      },
    });

    clearTimeout(t);
    if (!r.ok) return "";

    const html = await r.text();
    const text = stripHtml(html);
    return compact(text);
  } catch {
    return "";
  }
}

function stripHtml(html) {
  // Very lightweight HTML -> text
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|li|h1|h2|h3|h4|h5)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function compact(text) {
  return (text || "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function guessTitle(text) {
  // crude: take first 60 chars
  if (!text) return "";
  return text.slice(0, 60).trim();
}

async function callGeminiWithRetry({
  apiKey,
  model,
  systemInstruction,
  userInstruction,
  maxOutputTokens,
  timeoutMs,
  retries,
}) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: userInstruction }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens,
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await callOnce(url, payload, timeoutMs);
    if (result.ok) return result;

    // Only retry on 429/503-like situations
    if (!String(result.status).startsWith("429") && result.status !== 503) {
      return result;
    }

    // Backoff a bit
    await sleep(900 + attempt * 700);
  }

  return { ok: false, status: 429, text: "" };
}

async function callOnce(url, payload, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(t);

    const json = await r.json().catch(() => ({}));

    if (!r.ok) {
      return {
        ok: false,
        status: r.status,
        text: "",
        raw: json,
      };
    }

    const text =
      json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    return { ok: true, status: 200, text: text.trim(), raw: json };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 503, text: "", raw: String(e?.message || e) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
