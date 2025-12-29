import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, siteBaseUrl } = req.body;

  if (!question || !siteBaseUrl) {
    return res.status(400).json({ error: "Missing question or siteBaseUrl" });
  }

  // HARD prompt discipline to control quota
  const systemPrompt = `
You are an enterprise website summarization assistant.

Rules:
- Use ONLY the provided website content.
- Do NOT hallucinate.
- Keep the answer concise.
- Respect word limits strictly.
- No marketing fluff.
`;

  let userPrompt = "";

  if (question.includes("Customer Experience")) {
    userPrompt = `
Summarize Vation’s Customer Experience (CX) offerings in exactly 5 bullet points.
Each bullet must be one sentence.
Total response must be under 120 words.
Website: ${siteBaseUrl}
`;
  } else if (question.includes("Employee Experience")) {
    userPrompt = `
Summarize Vation’s Employee Experience (EX) offerings in exactly 5 bullet points.
Each bullet must be one sentence.
Total response must be under 120 words.
Website: ${siteBaseUrl}
`;
  } else {
    userPrompt = `
Summarize what Vation does as a company in no more than 120 words.
Use short paragraphs.
Website: ${siteBaseUrl}
`;
  }

  try {
    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: systemPrompt },
                { text: userPrompt },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 300,
          },
        }),
      }
    );

    const data = await geminiResponse.json();

    const answer =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response generated.";

    res.status(200).json({
      answer,
      source: siteBaseUrl,
    });
  } catch (error) {
    res.status(500).json({
      error: "Gemini request failed",
      details: error.message,
    });
  }
}
