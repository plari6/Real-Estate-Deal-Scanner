// One place to load a page: robots.txt check -> plain HTTP (fast) -> Puppeteer Stealth (JavaScript pages,
// bot walls). Remembers per source when HTTP is not enough.
import { httpGet, sleep, jitter } from './fetch/http.js';
import { robotsAllows } from './fetch/robots.js';
import { createBrowserPool } from './fetch/browser.js';

const BLOCK_MARKERS = /captcha|are you a robot|are you human|unusual traffic|access denied|datadome|perimeterx|px-captcha|cf-chl|challenge-platform|distil_r_captcha|incapsula|request unsuccessful|bot detection/i;

export function looksBlocked(status, body) {
  if ([401, 403, 429, 503].includes(status)) return true;
  // Only short pages: a real results page may mention "captcha" in a script.
  return body.length < 60000 && BLOCK_MARKERS.test(body.slice(0, 20000));
}

export class PageError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind; // robots | blocked | http | network
    this.status = status;
  }
}

export function createFetcher(settings = {}, { fetchImpl, log = () => {} } = {}) {
  let pool = null;
  const lastHit = new Map();
  const getPool = () => (pool ||= createBrowserPool(settings));

  async function politeWait(url) {
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + jitter(settings.pageDelayMs ?? 2500) - Date.now();
    lastHit.set(host, Date.now() + Math.max(0, wait));
    if (wait > 0) await sleep(wait);
  }

  /** @returns {Promise<{status:number, body:string, url:string, engine:'http'|'browser', ms:number}>} */
  async function fetchHtml(url, { engine = settings.engine || 'auto', waitForSelector, scrolls = 0 } = {}) {
    if (settings.respectRobots !== false && !(await robotsAllows(url, { fetchImpl }))) throw new PageError('blocked by robots.txt (set RESPECT_ROBOTS=false only with permission)', 'robots');
    await politeWait(url);
    if (engine !== 'browser') {
      try {
        const r = await httpGet(url, { timeoutMs: settings.timeoutMs, retries: settings.retries ?? 1, fetchImpl });
        if (!looksBlocked(r.status, r.body) && r.status < 400) return { ...r, engine: 'http' };
        if (engine === 'http') throw new PageError(`HTTP ${r.status}${looksBlocked(r.status, r.body) ? ' (bot wall)' : ''}`, looksBlocked(r.status, r.body) ? 'blocked' : 'http', r.status);
        log(`[fetch] HTTP ${r.status} on ${new URL(url).host}, trying the browser`);
      } catch (err) {
        if (engine === 'http' || err instanceof PageError) throw err;
        log(`[fetch] ${err.message} on ${new URL(url).host}, trying the browser`);
      }
    }
    const r = await getPool().fetchPage(url, { timeoutMs: settings.timeoutMs, waitForSelector, scrolls });
    if (looksBlocked(r.status, r.body)) throw new PageError(`bot wall in the browser too (HTTP ${r.status}); use PROXY_URL or a slower schedule`, 'blocked', r.status);
    if (r.status >= 400) throw new PageError(`HTTP ${r.status}`, 'http', r.status);
    return { ...r, engine: 'browser' };
  }

  return {
    fetchHtml,
    get browserUsed() { return Boolean(pool?.launched); },
    close: async () => { await pool?.close(); pool = null; },
  };
}
