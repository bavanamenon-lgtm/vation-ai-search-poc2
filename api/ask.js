// api/ask.js
// Vation AI Search – Guided Conversational RAG (Gemini)
// Purpose:
// - Gemini summarizes ONLY vation.com content
// - Short answers (token-safe)
// - Always nudges toward demo/contact
// - Ready for WordPress / real website integration

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  try {
    const { question, siteBaseUrl } = req.body || {};
    if (!question) {
      return res.status(400).json({ error: "Missing question" });
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const base = (siteBaseUrl || "https://vation.com").replace(/\/$/, "");

    /* ---------- Keep retrieval VERY SMALL ---------- */
    const urls = [
      `${base}/`,
      `${base}/solutions/`,
      `${base}/contact/`
    ];

    const fetchText = async (url) => {
      const r = await fetch(url, { headers: { "User-Agent": "Vation-AI-POC" }});
      if (!r.ok) return "";
      const html = await r.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 2500); // HARD cap to protect quota
    };

    const pages = [];
    for (const u of urls) {
      try {
        const t = await fetchText(u);
        if (t.length > 200) pages.push({ url: u, text: t });
      } catch {}
    }

    if (!pages.length) {
      return res.json({
        answer: "I couldn’t find enough public information to answer this.",
        nextQuestions: [],
        cta: "Visit https://vation.com/contact to connect with the team."
      });
    }

    /* ---------- Gemini Prompt (CRITICAL PART) ---------- */
    const prompt = `
You are an AI assistant for Vation's website.

RULES:
- Answer ONLY using the content provided.
- Max 100 words.
- Be factual, not salesy.
- End with ONE gentle follow-up question inviting a demo or conversation.
- Do NOT mention being an AI or the word 'Gemini'.

User question:
"${question}"

Website content:
${pages.map(p => `SOURCE (${p.url}): ${p.text}`).join("\n\n")}
`;

    const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 180
          }
        })
      }
    );

    const json = await r.json();
    if (!r.ok) {
      return res.json({
        answer: "The AI service is temporarily unavailable. Please retry once.",
        nextQuestions: [],
        cta: "You can also reach us at https://vation.com/contact"
      });
    }

    const answer =
      json?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I couldn’t generate a clear summary from the available content.";

    /* ---------- Guided follow-ups (STATIC, NOT AI) ---------- */
    const guided = [
      "Would you like to see how this works in a live demo?",
      "Should I connect you with the Vation team for a quick walkthrough?",
      "Are you exploring solutions for Customer or Employee Experience?"
    ];

    return res.json({
      answer,
      sources: pages.map(p => ({ url: p.url })),
      nextQuestions: guided,
      cta: "Book a demo or contact Vation via https://vation.com/contact"
    });

  } catch (e) {
    return res.status(500).json({
      answer: "Something went wrong while generating the response.",
      error: e.message
    });
  }
}
