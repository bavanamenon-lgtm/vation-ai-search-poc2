export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { question, siteBaseUrl } = req.body || {};
    if (!question || !siteBaseUrl) {
      return res.status(400).json({ error: "Missing question or siteBaseUrl" });
    }

    const base = siteBaseUrl.replace(/\/$/, "");
    const candidateUrls = await getCandidateUrls(base);
    const picked = pickTopUrls(question, candidateUrls, 5);

    const docs = [];
    for (const url of picked) {
      const html = await fetchText(url);
      if (!html) continue;
      const text = extractMainText(html);
      if (!text || text.length < 200) continue;

      docs.push({
        title: guessTitle(html) || url,
        url,
        snippet: text.slice(0, 1400)
      });

      if (docs.length >= 4) break;
    }

    if (docs.length === 0) {
      return res.json({
        answer:
          "I couldn’t fetch enough public content from the website to answer confidently. Try again with different keywords, or provide a few page URLs to include.",
        sources: []
      });
    }

    const answer = await askGemini(question, docs);

    return res.json({
      answer,
      sources: docs.map(d => ({ title: d.title, url: d.url }))
    });

  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
}

async function getCandidateUrls(base) {
  const sitemapCandidates = [
    `${base}/sitemap_index.xml`,
    `${base}/sitemap.xml`,
  ];

  for (const sm of sitemapCandidates) {
    const xml = await fetchText(sm);
    if (!xml) continue;

    if (xml.includes("<sitemapindex")) {
      const sitemapUrls = extractXmlLocs(xml).slice(0, 6);
      const all = [];
      for (const child of sitemapUrls) {
        const childXml = await fetchText(child);
        if (!childXml) continue;
        all.push(...extractXmlLocs(childXml));
        if (all.length >= 400) break;
      }
      if (all.length) return dedupeUrls(all, base);
    }

    if (xml.includes("<urlset")) {
      const urls = extractXmlLocs(xml);
      if (urls.length) return dedupeUrls(urls, base);
    }
  }

  return [
    `${base}/`,
    `${base}/about/`,
    `${base}/contact/`,
    `${base}/services/`,
    `${base}/insights/`,
  ];
}

function extractXmlLocs(xml) {
  const locs = [];
  const re = /<loc>(.*?)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = decodeXml(m[1]).trim();
    if (url.startsWith("http")) locs.push(url);
  }
  return locs;
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function dedupeUrls(urls, base) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u.startsWith(base)) continue;
    if (u.includes("/wp-json/") || u.includes("feed") || u.match(/\.(jpg|png|webp|gif|svg)$/i)) continue;

    const clean = u.split("#")[0];
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length >= 800) break;
  }
  return out;
}

function pickTopUrls(question, urls, topN) {
  const qTokens = tokenize(question);
  const scored = urls.map(u => ({ u, score: scoreUrl(u, qTokens) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(x => x.u);
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => t.length >= 3);
}

function scoreUrl(url, qTokens) {
  const u = url.toLowerCase();
  let score = 0;
  for (const t of qTokens) if (u.includes(t)) score += 3;
  if (u.includes("/insight") || u.includes("/blog") || u.includes("/case")) score += 2;
  if (u.endsWith("/")) score += 0.5;
  return score;
}

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (POC AI Search)" } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function guessTitle(html) {
  const m = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function extractMainText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

async function askGemini(question, docs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "Gemini API key missing on server.";

const model = "gemini-2.5-flash";


  const systemRules = `
You are an AI website search assistant for vation.com.
You MUST answer ONLY using the provided page snippets.
If the snippets do not contain the answer, say: "I couldn't find this on the website yet."
Keep the answer crisp (max 8 lines).
At the end, include a short "Sources:" list with the page titles (no URLs).
Never invent claims or offerings not present in the snippets.
`;

  const snippetsBlock = docs
    .map((d, i) => `(${i + 1}) TITLE: ${d.title}\nURL: ${d.url}\nSNIPPET: ${d.snippet}`)
    .join("\n\n");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: `${systemRules}\n\nQUESTION: ${question}\n\nPAGES:\n${snippetsBlock}` }]
      }
    ]
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const t = await r.text();
    return `Gemini error: ${r.status} ${t.slice(0, 200)}`;
  }

  const json = await r.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ||
    "No answer returned.";

  return String(text).trim();
}
