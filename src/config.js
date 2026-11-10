// Settings from env (.env) and the list of portal searches to scan (sources.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load .env from the working directory, then the project folder (first value wins). */
export async function loadEnv() {
  if (process.env.DEAL_SCANNER_SKIP_DOTENV === '1') return;
  const { config } = await import('dotenv');
  for (const file of [path.resolve('.env'), path.join(ROOT, '.env')]) {
    if (fs.existsSync(file)) config({ path: file, quiet: true });
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v, d) => (v === undefined ? d : String(v).split(',').map((s) => s.trim()).filter(Boolean));
/** "20" and "0.2" both mean 20 %. */
const pct = (v, d) => {
  const n = num(v, d);
  return n > 1 ? n / 100 : n;
};

export function getSettings(env = process.env) {
  return {
    dbPath: path.resolve(env.DB_PATH || path.join(ROOT, 'data', 'deals.db')),
    sourcesPath: path.resolve(env.SOURCES_FILE || path.join(ROOT, 'sources.json')),
    cron: env.SCAN_CRON || '0 */3 * * *',
    timezone: env.SCAN_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    currency: env.DEFAULT_CURRENCY || 'EUR',
    areaUnit: /^(sqft|ft2|ft)$/i.test(env.AREA_UNIT || '') ? 'sqft' : 'm2', // display only, stored as m²

    // Deal rules
    dealThreshold: pct(env.DEAL_THRESHOLD, 0.2), // 20 % below market
    suspiciousThreshold: pct(env.SUSPICIOUS_THRESHOLD, 0.55), // deeper than this = probably a data error
    marketStat: ['median', 'mean', 'trimmed'].includes(env.MARKET_STAT) ? env.MARKET_STAT : 'median',
    minComps: num(env.MIN_COMPS, 5),
    geoRadiusKm: num(env.GEO_RADIUS_KM, 1.5), // "nearby" comparables (listings with coordinates)
    maxSpread: num(env.MAX_SPREAD, 0.4), // skip comparable groups whose middle 50 % spans more than 40 % of the median
    sizeRange: num(env.SIZE_RANGE, 0.6), // comparables between 0.4x and 1.6x the living area
    localOnly: bool(env.LOCAL_ONLY, true), // never fall back to a city-wide average when coordinates or district are known
    compsWindowDays: num(env.COMPS_WINDOW_DAYS, 90),
    excludeFlags: list(env.EXCLUDE_FLAGS, ['share', 'price_from', 'rent_to_own', 'auction']),
    minPrice: num(env.MIN_PRICE, 0),
    maxPrice: num(env.MAX_PRICE, 0),
    minScore: num(env.MIN_SCORE, 0),

    // Alerts
    maxAlertsPerScan: num(env.MAX_ALERTS_PER_SCAN, 25),
    realertDropPct: pct(env.REALERT_DROP_PCT, 0.03), // alert again when a known deal drops a further 3 %
    scanSummary: bool(env.SCAN_SUMMARY, true),

    // Scraping
    engine: env.ENGINE || 'auto', // auto | http | browser
    concurrency: num(env.CONCURRENCY, 3),
    browserConcurrency: num(env.BROWSER_CONCURRENCY, 2),
    pageDelayMs: num(env.PAGE_DELAY_MS, 2500),
    timeoutMs: num(env.REQUEST_TIMEOUT_MS, 30000),
    retries: num(env.RETRIES, 1),
    respectRobots: bool(env.RESPECT_ROBOTS, true),
    headless: env.HEADLESS !== 'false',
    chromePath: env.CHROME_PATH || undefined,
    proxyUrl: env.PROXY_URL || undefined,
    debugDir: bool(env.DEBUG_SCREENSHOTS, false) ? path.join(ROOT, 'data', 'debug') : null,
    detailPages: bool(env.FETCH_DEAL_DETAILS, true), // open each deal's page to read the description

    // AI (optional; everything works without keys)
    aiExtract: bool(env.AI_EXTRACT, true),
    aiReview: bool(env.AI_REVIEW, true),
    aiReviewMax: num(env.AI_REVIEW_MAX, 10),
  };
}

/**
 * sources.json: { "defaults": {...}, "sources": [ { name, url, pages, engine, adapter, selectors, defaults } ] }
 * `url` may contain {page} or {offset} (+ pageSize); otherwise `pageParam` (default "page") is added for pages > 1.
 */
export function loadSources(file) {
  if (!fs.existsSync(file)) throw new Error(`Sources file not found: ${file} (copy examples/sources.example.json to sources.json)`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shared = raw.defaults || {};
  const sources = (raw.sources || raw).map((s, i) => {
    if (!s.url) throw new Error(`Source #${i + 1} has no "url"`);
    return {
      name: s.name || new URL(s.url.replace('{page}', '1')).hostname,
      pages: 1,
      engine: 'auto',
      adapter: 'auto',
      enabled: true,
      ...s,
      defaults: { ...shared, ...(s.defaults || {}) },
    };
  });
  return sources.filter((s) => s.enabled !== false);
}

export function pageUrl(source, page) {
  // {offset} = (page - 1) * pageSize, for portals that page with ?index=24 or ?from=20
  if (source.url.includes('{offset}')) return source.url.replaceAll('{offset}', String((page - 1) * (source.pageSize || 20))).replaceAll('{page}', String(page));
  if (source.url.includes('{page}')) return source.url.replaceAll('{page}', String(page));
  if (page === 1) return source.url;
  const u = new URL(source.url);
  u.searchParams.set(source.pageParam || 'page', String(page));
  return u.toString();
}
