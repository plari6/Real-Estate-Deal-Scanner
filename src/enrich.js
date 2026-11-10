// Extra work done only for deals (a handful per scan): read the listing's own page for the description,
// then let the AI review it for hidden catches. Both steps degrade to keyword rules.
import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { parseJsonLdBlocks } from './adapters/jsonld.js';
import { detectFlags, FLAGS, flagLabel } from './flags.js';
import { formatMoney, parseArea } from './parse.js';

/** Description (and area if the card had none) from a listing detail page. */
export function readDetailPage(html) {
  const $ = cheerio.load(html);
  let description = null;
  let area = null;
  const walk = (n, d = 0) => {
    if (!n || typeof n !== 'object' || d > 6) return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, d + 1));
    if (!description && typeof n.description === 'string' && n.description.length > 40) description = n.description;
    if (!area && n.floorSize) area = parseArea(typeof n.floorSize === 'object' ? n.floorSize.value : n.floorSize, /FTK|FT/i.test(n.floorSize?.unitCode || '') ? 'sqft' : 'm2');
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, d + 1);
  };
  parseJsonLdBlocks($).forEach((b) => walk(b));
  if (!description) {
    const sel = '[class*=description],[class*=Description],[id*=description],[data-testid*=description],[itemprop=description],.expose-text,.listing-description';
    description = $(sel).first().text().replace(/\s+/g, ' ').trim() || null;
  }
  if (!description) description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || null;
  if (!area) {
    const m = $('body').text().replace(/\s+/g, ' ').match(/(living area|wohnfl[aä]che|surface habitable|superficie|size|area|floor area)\D{0,20}(\d[\d.,]*\s?(m²|m2|sqm|sq\.?\s?ft|sqft))/i);
    if (m) area = parseArea(m[2]);
  }
  return { description: description ? description.slice(0, 2000) : null, area_m2: area };
}

const REVIEW_SYSTEM = `You are a cautious real estate investment analyst. A listing is priced below the local market average.
Decide whether the discount looks genuine or is explained by a catch. Use only the facts given.
Return JSON only: {"verdict":"strong|check|skip","flags":[],"summary":"","checks":[]}
- flags: any of ${Object.keys(FLAGS).filter((k) => k !== 'no_area').join(', ')} that the text supports.
- summary: one or two plain sentences for an investor on Telegram.
- checks: up to 3 short things to verify before making an offer.
- verdict: strong = clean listing with a real discount; check = possible catch; skip = the discount is explained by a catch.`;

export function keywordReview(l, ev) {
  const serious = (l.flags || []).filter((f) => ['auction', 'share', 'price_from', 'rent_to_own'].includes(f));
  const soft = (l.flags || []).filter((f) => !serious.includes(f) && f !== 'no_area');
  const verdict = serious.length ? 'skip' : soft.length || ev.confidence < 0.6 ? 'check' : 'strong';
  const pct = Math.round((ev.discount || 0) * 100);
  const summary = serious.length || soft.length
    ? `${pct}% below ${ev.comps} similar listings (${ev.segment}), but flagged: ${[...serious, ...soft].map(flagLabel).join(', ')}.`
    : `${pct}% below ${ev.comps} similar listings (${ev.segment}); no red flags in the listing text.`;
  const checks = ['Confirm the living area and floor plan', 'Ask why the seller prices below market (time pressure, inheritance, renovation)'];
  if (l.flags?.includes('tenanted')) checks.unshift('Check the lease and current rent');
  if (l.flags?.includes('renovation')) checks.unshift('Get a renovation estimate before offering');
  return { verdict, flags: [], summary, checks: checks.slice(0, 3), by: 'rules' };
}

/** AI review with cache; falls back to keyword rules when no model answers. */
export async function reviewDeal(l, ev, { ai, store, settings = {}, log = () => {} } = {}) {
  const fallback = keywordReview(l, ev);
  if (!ai) return fallback;
  const key = crypto.createHash('sha1').update(['review-v1', l.uid, l.price, l.description || '', ev.segment].join('|')).digest('hex');
  const cached = store?.cacheGet(key);
  if (cached) return cached;
  const facts = [
    `Title: ${l.title || '?'}`,
    `Price: ${formatMoney(l.price, l.currency)}${l.deal_type === 'rent' ? ' per month' : ''}`,
    `Area: ${l.area_m2 ? `${l.area_m2} m²` : 'unknown'} · Rooms: ${l.rooms ?? '?'} · Type: ${l.property_type}`,
    `Location: ${[l.district, l.city].filter(Boolean).join(', ')}`,
    `Market: ${ev.metric === 'm2' ? `${formatMoney(ev.market, l.currency)}/m²` : formatMoney(ev.market, l.currency)} median of ${ev.comps} comparables (${ev.segment}); this listing is ${Math.round(ev.discount * 100)}% below.`,
    `Keyword flags: ${(l.flags || []).join(', ') || 'none'}`,
    `Description: ${(l.description || 'not available').slice(0, 1500)}`,
  ].join('\n');
  try {
    const r = await ai.generate({
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: facts }],
      json: true,
      maxTokens: 1024,
      temperature: 0.2,
      parse: (t) => {
        const j = JSON.parse(t.replace(/^```(json)?\s*|\s*```$/g, ''));
        if (!['strong', 'check', 'skip'].includes(j.verdict) || typeof j.summary !== 'string') throw new Error('bad review JSON');
        return j;
      },
    });
    const review = {
      verdict: r.data.verdict,
      flags: (r.data.flags || []).filter((f) => FLAGS[f]),
      summary: r.data.summary.slice(0, 400),
      checks: (r.data.checks || []).slice(0, 3).map((c) => String(c).slice(0, 120)),
      by: r.target,
    };
    store?.cacheSet(key, review);
    return review;
  } catch (err) {
    log(`[ai] review unavailable (${err.message}), using keyword rules`);
    return fallback;
  }
}

/** Fetch detail pages of deals and re-check flags. Mutates and returns the listing. */
export async function enrichFromDetail(l, fetchHtml, { log = () => {} } = {}) {
  try {
    const { body } = await fetchHtml(l.url);
    const d = readDetailPage(body);
    if (d.description && (!l.description || d.description.length > l.description.length)) l.description = d.description;
    if (!l.area_m2 && d.area_m2) {
      l.area_m2 = d.area_m2;
      l.price_m2 = Math.round((l.price / d.area_m2) * 100) / 100;
    }
    l.flags = detectFlags({ ...l, flags: (l.flags || []).filter((f) => f !== 'no_area') });
  } catch (err) {
    log(`[detail] ${l.url}: ${err.message}`);
  }
  return l;
}
