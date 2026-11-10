// HTML cards. Two modes:
//  - selectors from sources.json ({ card, title, price, area, rooms, location, link, image, description });
//    "css@attr" reads an attribute, e.g. "a.card-link@href" or "img@data-src".
//  - heuristic: finds the most repeated element that contains a price and a link, then mines its text.

const CUR = '€|£|\\$|₹|₺|\\b(?:eur|usd|gbp|aed|sar|qar|kwd|bhd|omr|egp|chf|mad|dh|dhs|dirhams?|try|tl|inr|cad|aud|pln)\\b|درهم|ريال|جنيه';
const CURRENCY_HINT = new RegExp(`(${CUR})`, 'i');
const PRICE_TEXT = new RegExp(`((${CUR})\\s?\\d[\\d\\s.,'’]*\\d(\\s?(k|m|mio\\.?|million|mn))?(\\s?(\\/\\s?\\w+|pcm|p\\.?m\\.?|per month))?|\\d[\\d\\s.,'’]*\\d\\s?(k|m|mio\\.?|million|mn)?\\s?(${CUR})(\\s?(\\/\\s?\\w+|pcm|p\\.?m\\.?|per month))?)`, 'i');
const AREA_TEXT = /\d[\d\s.,]*\s?(m²|m2|sq\.?\s?m\b|sqm|qm\b|㎡|م²|sq\.?\s?ft\.?|sqft|ft²)/i;
const ROOMS_TEXT = /(\d+(?:[.,]5)?)\s*(rooms?|zimmer|zi\.|pi[eè]ces?|habitaci[oó]n(?:es)?|dormitorios?|beds?|bedrooms?|bd\b|br\b|bhk|chambres?|غرف|غرفة)|\bstudio\b/i;

/** Element text with a space between child elements ("Riviera</h2><span>1 700 000 DH" -> "Riviera 1 700 000 DH"). */
export function spacedText($, el) {
  const parts = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === 'text') parts.push(c.data);
      else if (c.type === 'tag' && !['script', 'style', 'noscript'].includes(c.name)) { parts.push(' '); walk(c); parts.push(' '); }
    }
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** "css@attr" -> value. Empty selector = the element itself. */
export function readSel($, root, spec) {
  if (!spec) return null;
  for (const one of String(spec).split('||').map((s) => s.trim())) {
    const at = one.lastIndexOf('@');
    const sel = at > 0 ? one.slice(0, at).trim() : one;
    const attr = at > 0 ? one.slice(at + 1).trim() : null;
    const el = sel === ':self' || sel === '' ? root : $(root).find(sel).first();
    if (!el || !$(el).length) continue;
    const v = attr ? $(el).attr(attr) : $(el).text();
    const clean = v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    if (clean) return clean;
  }
  return null;
}

export function extractCss($, pageUrl, selectors) {
  const out = [];
  $(selectors.card).each((_, card) => {
    const r = (k) => readSel($, card, selectors[k]);
    const text = spacedText($, card);
    const priceText = r('price');
    out.push({
      url: r('link') || $(card).find('a[href]').first().attr('href') || $(card).attr('href') || null,
      id: r('id'),
      title: r('title'),
      price: priceText,
      priceText,
      area: r('area') || text.match(AREA_TEXT)?.[0] || null,
      rooms: r('rooms') || text.match(ROOMS_TEXT)?.[0] || null,
      bedrooms: r('bedrooms'),
      address: r('location') || r('address'),
      district: r('district'),
      city: r('city'),
      type: r('type'),
      image: r('image') || $(card).find('img').first().attr('data-src') || $(card).find('img').first().attr('src') || null,
      description: r('description'),
      lat: r('lat') || $(card).attr('data-lat') || $(card).attr('data-latitude') || null,
      lng: r('lng') || $(card).attr('data-lng') || $(card).attr('data-lon') || $(card).attr('data-longitude') || null,
      _text: text,
      _method: 'css',
    });
  });
  return out;
}

const signature = ($, el) => `${el.tagName}.${String($(el).attr('class') || '').trim().split(/\s+/).filter((c) => !/\d{3,}|active|selected|first|last|odd|even/.test(c)).sort().join('.')}`;

/** No config: group elements by tag+class, keep groups whose members each hold one price and a link. */
export function extractCards($, pageUrl) {
  const groups = new Map();
  $('article, li, div, a, section').each((_, el) => {
    const cls = $(el).attr('class');
    if (!cls && el.tagName !== 'article') return;
    const text = spacedText($, el);
    if (text.length > 1500 || text.length < 15 || !CURRENCY_HINT.test(text) || !PRICE_TEXT.test(text)) return;
    const hasLink = el.tagName === 'a' ? Boolean($(el).attr('href')) : $(el).find('a[href]').length > 0;
    if (!hasLink) return;
    const sig = signature($, el);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(el);
  });
  // Best group: at least 3 members, the most members, and members that are not nested in each other.
  let best = null;
  for (const [sig, els] of groups) {
    if (els.length < 3) continue;
    const prices = els.map((el) => ($(el).text().match(new RegExp(PRICE_TEXT, 'gi')) || []).length);
    const oneish = prices.filter((n) => n >= 1 && n <= 3).length / els.length;
    const score = els.length * oneish * (/(listing|property|result|card|estate|offer|item|expose|ad\b|tile)/i.test(sig) ? 1.5 : 1);
    if (!best || score > best.score) best = { sig, els, score };
  }
  if (!best) return [];
  return best.els.map((el) => {
    const text = spacedText($, el);
    const link = el.tagName === 'a' ? $(el).attr('href') : $(el).find('a[href]').filter((_, a) => !/^(#|javascript:|mailto:|tel:)/.test($(a).attr('href'))).first().attr('href');
    const title = $(el).find('h1,h2,h3,h4,[class*=title],[class*=Title]').first().text().replace(/\s+/g, ' ').trim()
      || $(el).find('a[href]').first().attr('title') || $(el).find('a[href]').first().text().replace(/\s+/g, ' ').trim() || null;
    const priceText = $(el).find('[class*=price],[class*=Price],[data-testid*=price]').first().text().replace(/\s+/g, ' ').trim() || text.match(PRICE_TEXT)?.[0] || null;
    const loc = $(el).find('[class*=address],[class*=location],[class*=Address],[class*=Location],address').first().text().replace(/\s+/g, ' ').trim() || null;
    const img = $(el).find('img').first();
    return {
      url: link || null,
      title,
      price: priceText,
      priceText,
      area: text.match(AREA_TEXT)?.[0] || null,
      rooms: text.match(ROOMS_TEXT)?.[0] || null,
      address: loc,
      image: img.attr('data-src') || img.attr('src') || null,
      _text: text,
      _method: 'cards',
    };
  });
}
