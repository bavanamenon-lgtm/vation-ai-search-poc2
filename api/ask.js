export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { question, siteBaseUrl } = req.body;

    if (!question || !siteBaseUrl) {
      return res.status(400).json({
        error: "Missing required fields: question, siteBaseUrl"
      });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Gemini API key missing on server" });
    }

    /* ============================
       STEP 1: Get URLs from sitemap
       ============================ */
    const sitemapUrl = siteBaseUrl.replace(/\/$/, "") + "/sitemap.xml";
    let urls = [];

    try {
      const smRes = await fetch(sitemapUrl, { timeout: 8000 });
      if (smRes.ok) {
        const xml = await smRes.text();
        urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
          .map(m => m[1])
          .slice(0, 10); // limit for POC
      }
    } catch (e) {
      // Ignore sitemap failure (POC-safe)
    }

    // Fallback URLs if sitemap not accessible
    if (urls.length === 0) {
      urls = [
        siteBaseUrl,
        `${siteBaseUrl}/about`,
        `${siteBaseUrl}/services`,
        `${siteBaseUrl}/insights`,
        `${siteBaseUrl}/contact`
      ];
    }

    /* ============================
       STEP 2: Fetch page content
       ============================ */
    const pages = [];

    for (const url of urls) {
      try {
        const r = await fetch(url, { timeout: 8000 });
        if (!r.ok) continue;

        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        if (text.length > 200) {
          pages.push({
            url,
            snippet: text.slice(0, 700) // token-safe
          });
        }
      } catch (e) {
        // skip bad pages
      }
    }

    if (pages.length === 0) {
      return res.json({
        answer: "I couldn’t find enough information on the website to answer that.",
        sources: []
      });
    }

    /* ============================
       STEP 3: Gemini prompt
       ============================ */
    const prompt = `
You are an AI search assistant for a company website.

Answer the question ONLY using the content provided below.
Do NOT use external knowledge.
If the answer is not clearly present, say so honestly.
Keep the answer concise and professional.

Question:
${question}

Website content:
${pages.map(p => `SOURCE (${p.url}): ${p.snippet}`).join("\n\n")}
`;

    /* ============================
       STEP 4: Call Gemini 2.5
       ============================ */
    const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();

      if (geminiRes.status === 429) {
        return res.json({
          answer:
            "The AI service is temporarily rate-limited. Please try again in 30–60 seconds.",
          sources: pages.map(p => ({ url: p.url }))
        });
      }

      return res.json({
        answer: `Gemini error: ${geminiRes.status}`,
        details: errText.slice(0, 300),
        sources: pages.map(p => ({ url: p.url }))
      });
    }

    const geminiJson = await geminiRes.json();
    const answer =
      geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I couldn’t generate a clear answer from the available content.";

    /* ============================
       STEP 5: Return response
       ============================ */
    return res.json({
      answer,
      sources: pages.map(p => ({ url: p.url }))
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected server error",
      message: err.message
    });
  }
}
