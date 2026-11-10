// A scan: read every configured search (all pages) -> store listings -> value each one against the market
// -> enrich + review the deals -> alert once per deal (again only after a further price drop).
import { pageUrl } from './config.js';
import { extractListings } from './adapters/index.js';
import { createFetcher } from './fetcher.js';
import { buildIndex, evaluateListing } from './market.js';
import { enrichFromDetail, reviewDeal } from './enrich.js';
import { dispatch } from './notify.js';
import { semaphore } from './fetch/browser.js';

const REVIEW_PENALTY = { skip: 25, check: 6, strong: 0 };

/** Read all pages of one source. */
export async function scanSource(source, { fetcher, settings, ai, store, log = () => {} }) {
  const learned = store?.kvGet(`engine:${source.name}`);
  let engine = source.engine && source.engine !== 'auto' ? source.engine : learned || settings.engine || 'auto';
  const listings = new Map();
  const pages = [];
  for (let p = 1; p <= (source.pages || 1); p++) {
    const url = pageUrl(source, p);
    let res = await fetcher.fetchHtml(url, { engine, waitForSelector: source.waitForSelector || source.selectors?.card, scrolls: source.scrolls || 0 });
    let ex = await extractListings(res.body, res.url || url, source, { ai, aiExtract: settings.aiExtract, currency: settings.currency, log });
    // JavaScript-rendered results: HTTP got the page shell only, so retry once with the browser.
    if (!ex.listings.length && res.engine === 'http' && engine === 'auto') {
      log(`[scan] ${source.name} p${p}: nothing in the HTML, retrying with the browser`);
      res = await fetcher.fetchHtml(url, { engine: 'browser', waitForSelector: source.waitForSelector || source.selectors?.card, scrolls: source.scrolls || 0 });
      ex = await extractListings(res.body, res.url || url, source, { ai, aiExtract: settings.aiExtract, currency: settings.currency, log });
      if (ex.listings.length) { engine = 'browser'; store?.kvSet(`engine:${source.name}`, 'browser'); }
    }
    const before = listings.size;
    for (const l of ex.listings) if (!listings.has(l.uid)) listings.set(l.uid, l);
    pages.push({ page: p, url, engine: res.engine, method: ex.method, found: ex.listings.length, added: listings.size - before, tried: ex.tried });
    log(`[scan] ${source.name} p${p}: ${ex.listings.length} listings via ${ex.method || 'nothing'} (${res.engine})`);
    // Past the last page: empty, or the portal repeats the same page.
    if (!ex.listings.length || listings.size === before) break;
  }
  return { listings: [...listings.values()], pages };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./db.js').openDb>} o.store
 * @param {object[]} o.sources
 * @param {object} o.settings
 * @param {object} [o.ai]        multi-model router (optional)
 * @param {object[]} [o.channels]
 */
export async function runScan({ store, sources, settings, ai = null, channels = [], fetcher: injected, dryRun = false, log = console.log, warn = console.warn, now = () => new Date() }) {
  const t0 = Date.now();
  const scanId = store.startScan(now().toISOString());
  const fetcher = injected || createFetcher(settings, { log });
  const summary = { scanId, sources: sources.length, sourcesOk: 0, listings: 0, newListings: 0, priceDrops: 0, deals: 0, suspicious: 0, unrated: 0, alerts: 0, failures: [], perSource: [], topDeals: [] };
  const seen = []; // { listing, isNew, prevPrice }

  try {
    const limit = semaphore(Math.max(1, settings.concurrency || 3));
    await Promise.all(sources.map((source) => limit(async () => {
      try {
        const r = await scanSource(source, { fetcher, settings, ai, store, log });
        const stamp = now().toISOString();
        for (const l of r.listings) seen.push(store.upsertListing(l, stamp));
        summary.sourcesOk++;
        summary.perSource.push({ source: source.name, listings: r.listings.length, pages: r.pages.length, method: r.pages[0]?.method, engine: r.pages[0]?.engine });
        if (!r.listings.length) summary.failures.push({ source: source.name, error: `0 listings found (tried: ${r.pages[0]?.tried.map((t) => `${t.adapter}=${t.count}`).join(', ')}); run test-source` });
      } catch (err) {
        warn(`[scan] ${source.name} failed: ${err.message}`);
        summary.failures.push({ source: source.name, error: err.message, kind: err.kind });
        summary.perSource.push({ source: source.name, listings: 0, error: err.message });
      }
    })));

    summary.listings = seen.length;
    summary.newListings = seen.filter((s) => s.isNew).length;
    summary.priceDrops = seen.filter((s) => s.prevPrice && s.listing.price < s.prevPrice).length;

    // Value every listing seen in this scan against all recent listings.
    let index = buildIndex(store.activeListings(settings.compsWindowDays, now()));
    const evaluated = seen.map((s) => {
      const ev = evaluateListing(s.listing, index, settings);
      store.saveEvaluation(s.listing.id, ev, now().toISOString());
      return { ...s, ev };
    });

    // Which deals need an alert? New ones, and known ones that dropped a further REALERT_DROP_PCT.
    const toAlert = [];
    for (const e of evaluated.filter((x) => x.ev.status === 'deal').sort((a, b) => b.ev.score - a.ev.score)) {
      const last = store.lastAlert(e.listing.id);
      if (!last) toAlert.push({ ...e, type: 'new_deal' });
      else if (e.listing.price <= last.price * (1 - settings.realertDropPct)) toAlert.push({ ...e, type: 'price_drop', prevPrice: last.price });
    }

    // Enrich + review only what will be sent (bounded cost), then re-value with what we learned.
    const enrichCount = Math.min(toAlert.length, Math.max(settings.aiReviewMax || 10, settings.maxAlertsPerScan || 25));
    let enriched = 0;
    for (const a of toAlert.slice(0, enrichCount)) {
      if (settings.detailPages) {
        enriched++;
        await enrichFromDetail(a.listing, (u) => fetcher.fetchHtml(u, {}), { log });
        store.setDetails(a.listing.id, { description: a.listing.description, area_m2: a.listing.area_m2, flags: a.listing.flags });
        a.listing = store.getListing(a.listing.id);
      }
    }
    const reviewSlots = settings.aiReview ? settings.aiReviewMax : 0;
    let reviewed = 0;
    if (enriched) index = buildIndex(store.activeListings(settings.compsWindowDays, now()));
    for (const a of toAlert) {
      a.ev = evaluateListing(a.listing, index, settings);
      if (a.ev.status === 'deal') {
        a.review = await reviewDeal(a.listing, a.ev, { ai: reviewed++ < reviewSlots ? ai : null, store, settings, log });
        if (a.review.flags?.length) {
          const flags = [...new Set([...(a.listing.flags || []), ...a.review.flags])];
          store.setFlags(a.listing.id, flags);
          a.listing.flags = flags;
          a.ev = evaluateListing(a.listing, index, settings);
        }
        if (a.ev.status === 'deal') {
          a.ev.score = Math.max(0, a.ev.score - (REVIEW_PENALTY[a.review.verdict] || 0));
          if (settings.minScore && a.ev.score < settings.minScore) { a.ev.status = 'excluded'; a.ev.reasons.push(`score ${a.ev.score} < MIN_SCORE after review`); }
        }
        store.setAiReview(a.listing.id, a.review);
      }
      store.saveEvaluation(a.listing.id, a.ev, now().toISOString());
    }

    const send = toAlert.filter((a) => a.ev.status === 'deal').sort((a, b) => b.ev.score - a.ev.score);
    const capped = send.slice(0, settings.maxAlertsPerScan || 25);
    for (const a of capped) {
      const ok = dryRun ? [] : await dispatch(channels, 'send', a, { warn });
      if (!dryRun) store.addAlert({ listingId: a.listing.id, type: a.type, price: a.listing.price, discount: a.ev.discount, score: a.ev.score, channels: ok }, now().toISOString());
      summary.alerts++;
    }
    if (send.length > capped.length) summary.failures.push({ source: 'alerts', error: `${send.length - capped.length} more deal(s) over MAX_ALERTS_PER_SCAN, see the report` });

    // Final counts from the stored state of this scan's listings.
    for (const s of seen) {
      const l = store.getListing(s.listing.id);
      if (l.deal_status === 'deal') summary.deals++;
      if (l.deal_status === 'suspicious') summary.suspicious++;
      if (l.deal_status === 'unrated') summary.unrated++;
    }
    summary.topDeals = store.deals({ limit: 5, now: now() }).map((l) => ({ title: l.title, url: l.url, price: l.price, currency: l.currency, discount: l.discount, score: l.score }));
  } finally {
    if (!injected) await fetcher.close();
  }
  summary.ms = Date.now() - t0;
  store.finishScan(scanId, summary, now().toISOString());
  if (!dryRun && settings.scanSummary && channels.length) await dispatch(channels, 'summary', summary, { warn });
  return summary;
}

/** Re-value every recent listing (after an import, or when the rules changed). No alerts. */
export function revalueAll(store, settings, { now = () => new Date() } = {}) {
  const active = store.activeListings(settings.compsWindowDays, now());
  const index = buildIndex(active);
  const counts = { listings: active.length, deal: 0, suspicious: 0, excluded: 0, fair: 0, unrated: 0 };
  for (const l of active) {
    const ev = evaluateListing(l, index, settings);
    store.saveEvaluation(l.id, ev, now().toISOString());
    counts[ev.status]++;
  }
  return counts;
}
