// Last resort: ask the LLM (multi-model fallback chain) to read the page text and list the properties.
// Guarded against hallucination: the price digits must appear in the page and the link must be a real link.
import { cleanUrl } from '../parse.js';

const SYSTEM = `You extract real estate listings from the text of a property search results page.
Return JSON only: {"listings":[{"url":"","title":"","price":"","area":"","rooms":null,"location":"","type":"","deal":"sale|rent"}]}
Rules:
- One entry per property card. Skip ads, agents, "similar searches" and navigation.
- "url" must be copied exactly from a [link: ...] marker of that card.
- "price" and "area" are copied as written on the page (with currency / unit), never computed.
- If a value is not on the page use null. Do not invent properties.`;

/** Page text with links inline as [link: URL], trimmed to maxChars. */
export function pageTextWithLinks($, pageUrl, maxChars = 24000) {
  const $b = $('body').clone();
  $b.find('script,style,noscript,svg,iframe,header nav,footer').remove();
  const links = new Set();
  $b.find('a[href]').each((_, a) => {
    const url = cleanUrl($(a).attr('href'), pageUrl);
    if (!url) return;
    links.add(url);
    $(a).append(` [link: ${url}] `);
  });
  const text = $b.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { text: text.slice(0, maxChars), links };
}

const digits = (s) => String(s ?? '').replace(/\D/g, '');

export async function extractWithAI($, pageUrl, ai, { log = () => {} } = {}) {
  if (!ai) return [];
  const { text, links } = pageTextWithLinks($, pageUrl);
  if (text.length < 200) return [];
  let res;
  try {
    res = await ai.generate({
      system: SYSTEM,
      messages: [{ role: 'user', content: `Page: ${pageUrl}\n\n${text}` }],
      json: true,
      maxTokens: 4096,
      temperature: 0,
      parse: (t) => {
        const j = JSON.parse(t.replace(/^```(json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(j.listings)) throw new Error('no listings array');
        return j;
      },
    });
  } catch (err) {
    log(`[ai] extraction unavailable: ${err.message}`);
    return [];
  }
  const pageDigits = digits(text);
  const out = [];
  for (const l of res.data.listings) {
    const url = cleanUrl(l.url, pageUrl);
    const p = digits(l.price);
    // Hallucination guard: real link from the page, price digits present in the page text.
    if (!url || !links.has(url) || p.length < 3 || !pageDigits.includes(p)) continue;
    out.push({
      url,
      title: l.title || null,
      price: l.price,
      priceText: l.price,
      area: l.area || null,
      rooms: l.rooms ?? null,
      address: l.location || null,
      type: l.type || null,
      dealType: l.deal === 'rent' ? 'rent' : l.deal === 'sale' ? 'sale' : null,
      _method: `ai:${res.target}`,
    });
  }
  return out;
}
