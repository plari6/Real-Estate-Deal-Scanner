// Picks the best way to read a search results page: configured CSS -> JSON-LD -> embedded JSON ->
// heuristic cards -> AI. Every adapter's output goes through the same normalizer.
import * as cheerio from 'cheerio';
import { extractJsonLd } from './jsonld.js';
import { extractEmbedded } from './embedded.js';
import { extractCss, extractCards } from './css.js';
import { extractWithAI } from './ai.js';
import { normalizeListing } from '../normalize.js';

export const ADAPTERS = ['css', 'jsonld', 'embedded', 'cards', 'ai'];

function run(name, $, html, pageUrl, source) {
  switch (name) {
    case 'css': return source.selectors?.card ? extractCss($, pageUrl, source.selectors) : [];
    case 'jsonld': return extractJsonLd($, pageUrl);
    case 'embedded': return extractEmbedded($, html, source);
    case 'cards': return extractCards($, pageUrl);
    default: return [];
  }
}

function normalizeAll(raws, ctx) {
  const byUid = new Map();
  for (const r of raws) {
    const l = normalizeListing(r, ctx);
    if (l && !byUid.has(l.uid)) byUid.set(l.uid, l);
  }
  return [...byUid.values()];
}

// More listings wins; area, district and rooms make a listing more useful; structured data beats text mining on a tie.
const STRUCTURED = new Set(['css', 'jsonld', 'embedded']);
const quality = (ls, name) => ls.length * (STRUCTURED.has(name) ? 1.2 : 1)
  + 0.5 * ls.filter((l) => l.area_m2).length + 0.3 * ls.filter((l) => l.district).length + 0.2 * ls.filter((l) => l.rooms != null).length;

/**
 * @returns {Promise<{listings: object[], method: string|null, tried: {adapter: string, count: number}[]}>}
 */
export async function extractListings(html, pageUrl, source, { ai = null, aiExtract = true, currency, log = () => {} } = {}) {
  const $ = cheerio.load(html);
  const ctx = { source, pageUrl, currency };
  const forced = source.adapter && source.adapter !== 'auto' ? source.adapter : null;
  const order = forced ? [forced] : ['css', 'jsonld', 'embedded', 'cards'];
  const tried = [];
  let best = { listings: [], method: null };

  for (const name of order) {
    if (name === 'ai') continue;
    let listings = [];
    try {
      listings = normalizeAll(run(name, $, html, pageUrl, source), ctx);
    } catch (err) {
      log(`[extract] ${name} failed: ${err.message}`);
    }
    tried.push({ adapter: name, count: listings.length });
    if (quality(listings, name) > quality(best.listings, best.method)) best = { listings, method: name };
    // Configured selectors are authoritative when they match.
    if (name === 'css' && listings.length) break;
  }

  if (!best.listings.length && aiExtract && ai && (!forced || forced === 'ai')) {
    const listings = normalizeAll(await extractWithAI($, pageUrl, ai, { log }), ctx);
    tried.push({ adapter: 'ai', count: listings.length });
    if (listings.length) best = { listings, method: 'ai' };
  }
  return { ...best, tried };
}
