import test from 'node:test';
import assert from 'node:assert/strict';
import { startDemoPortals, demoSources } from '../src/demo.js';
import { openDb } from '../src/db.js';
import { getSettings } from '../src/config.js';
import { runScan, revalueAll, scanSource } from '../src/scanner.js';
import { createFetcher, looksBlocked } from '../src/fetcher.js';
import { clearRobotsCache } from '../src/fetch/robots.js';
import { keywordReview, readDetailPage, reviewDeal } from '../src/enrich.js';

const settings = () => ({ ...getSettings({}), pageDelayMs: 0, engine: 'http' });
const capture = () => {
  const sent = [];
  const summaries = [];
  return { sent, summaries, channel: { name: 'capture', send: async (a) => sent.push(a), summary: async (s) => summaries.push(s) } };
};
const quiet = { log: () => {}, warn: () => {} };

test('demo market: finds the planted bargains, holds back traps, re-alerts only on further drops', async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  const store = openDb(':memory:');
  const c = capture();
  const sources = demoSources(portals.base);

  const s1 = await runScan({ store, sources, settings: settings(), channels: [c.channel], ...quiet });
  assert.equal(s1.sourcesOk, 3);
  assert.equal(s1.listings, 108);
  assert.deepEqual(s1.perSource.map((p) => p.method).sort(), ['css', 'embedded', 'jsonld']);
  const titles = c.sent.map((a) => a.listing.title);
  assert.ok(titles.some((x) => x.startsWith('Inheritance sale')));
  assert.ok(titles.some((x) => x.includes('private seller')));
  assert.ok(titles.some((x) => x.includes('need of renovation')), 'renovation is alerted, with its flag');
  for (const trap of ['Auction', 'prices from', 'to rent']) assert.ok(!titles.some((x) => x.includes(trap)), `${trap} must not be alerted`);
  assert.ok(!titles.includes('3-room apartment in Friedrichshain'), 'the 80 % "deal" is held back as suspicious');
  assert.equal(s1.suspicious, 1);
  const reno = c.sent.find((a) => a.listing.title.includes('renovation'));
  assert.ok(reno.listing.flags.includes('renovation'));
  assert.equal(reno.review.by, 'rules');
  assert.equal(c.summaries.length, 1);
  // Every alert has a working link, a market value and a score.
  for (const a of c.sent) {
    assert.match(a.listing.url, /^http:\/\/127\.0\.0\.1:\d+\/listing\/\w+$/);
    assert.ok(a.ev.market > 0 && a.ev.score > 0 && a.ev.discount >= 0.2);
  }
  // Detail pages were read for the deals.
  assert.match(store.getListing(reno.listing.id).description, /old heating/);

  // Same day again: nothing new to send.
  c.sent.length = 0;
  const again = await runScan({ store, sources, settings: settings(), channels: [c.channel], ...quiet });
  assert.equal(again.alerts, 0);

  // Day 2: one known deal drops a further 5.6 %, one fair flat is cut 28 %.
  portals.setDay(2);
  const s2 = await runScan({ store, sources, settings: settings(), channels: [c.channel], ...quiet });
  assert.equal(s2.alerts, 2);
  const drop = c.sent.find((a) => a.type === 'price_drop');
  assert.ok(drop.listing.title.startsWith('Inheritance sale'));
  assert.equal(drop.prevPrice, 359000);
  assert.ok(c.sent.some((a) => a.type === 'new_deal' && a.listing.title.startsWith('Price reduced')));
  assert.deepEqual(store.priceHistory(drop.listing.id).map((h) => h.price), [359000, 339000]);
  store.close();
});

test('dry run sends nothing and records no alerts; revalueAll re-rates without alerts', async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  const store = openDb(':memory:');
  const c = capture();
  const s = await runScan({ store, sources: demoSources(portals.base), settings: settings(), channels: [c.channel], dryRun: true, ...quiet });
  assert.ok(s.alerts >= 4);
  assert.equal(c.sent.length, 0);
  assert.equal(store.alerts().length, 0);
  const counts = revalueAll(store, { ...settings(), dealThreshold: 0.3 });
  assert.equal(counts.listings, 108);
  assert.ok(counts.deal >= 1 && counts.deal < 4, 'a stricter threshold leaves fewer deals');
  store.close();
});

test('pagination stops when a portal repeats a page; robots.txt and bot walls are reported', async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  clearRobotsCache();
  const fetcher = createFetcher({ ...settings() });
  t.after(() => fetcher.close());
  const [a] = demoSources(portals.base);
  const r = await scanSource({ ...a, pages: 10 }, { fetcher, settings: settings(), store: null });
  assert.equal(r.pages.length, 4, '3 real pages + 1 empty page, then stop');
  assert.equal(r.listings.length, 36);

  await assert.rejects(fetcher.fetchHtml(`${portals.base}/private/search`), /robots\.txt/);
  await assert.rejects(fetcher.fetchHtml(`${portals.base}/blocked`, { engine: 'http' }), (err) => err.kind === 'blocked');
  assert.equal(looksBlocked(200, '<html>please solve the captcha</html>'), true);
  assert.equal(looksBlocked(200, `<html>${'x'.repeat(70000)} captcha</html>`), false);

  const store = openDb(':memory:');
  const s = await runScan({ store, sources: [{ name: 'broken', url: `${portals.base}/blocked`, pages: 1, engine: 'http', defaults: {} }], settings: settings(), fetcher, ...quiet });
  assert.equal(s.sourcesOk, 0);
  assert.equal(s.failures[0].source, 'broken');
  store.close();
});

test('detail page reader and deal review (AI JSON, AI down, cache)', async () => {
  const d = readDetailPage('<html><head><script type="application/ld+json">{"@type":"Apartment","description":"Sold with a sitting tenant, rent 900 per month, lease until 2028.","floorSize":{"value":75,"unitCode":"MTK"}}</script></head></html>');
  assert.match(d.description, /sitting tenant/);
  assert.equal(d.area_m2, 75);

  const l = { uid: 'x:1', title: 'Flat', price: 300000, currency: 'EUR', deal_type: 'sale', area_m2: 75, rooms: 3, property_type: 'apartment', city: 'Berlin', district: 'Mitte', flags: [], description: d.description };
  const ev = { discount: 0.3, market: 6000, metric: 'm2', comps: 12, segment: 'Mitte · apartment', confidence: 0.9 };
  const cache = new Map();
  const store = { cacheGet: (k) => cache.get(k), cacheSet: (k, v) => cache.set(k, v) };
  let calls = 0;
  const ai = { generate: async ({ parse }) => { calls++; return { target: 'fake:m', data: parse('{"verdict":"check","flags":["tenanted","made_up"],"summary":"Tenanted until 2028.","checks":["Read the lease"]}') }; } };
  const r = await reviewDeal(l, ev, { ai, store });
  assert.equal(r.verdict, 'check');
  assert.deepEqual(r.flags, ['tenanted']);
  assert.equal(r.by, 'fake:m');
  await reviewDeal(l, ev, { ai, store });
  assert.equal(calls, 1, 'second review comes from the cache');
  const down = await reviewDeal({ ...l, uid: 'x:2' }, ev, { ai: { generate: async () => { throw new Error('503'); } }, store });
  assert.equal(down.by, 'rules');
  assert.equal(keywordReview({ ...l, flags: ['auction'] }, ev).verdict, 'skip');
});

test('AI review flags can turn a deal into an excluded listing during a scan', async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  const store = openDb(':memory:');
  const c = capture();
  // The fake model says every deal is a partial share -> all excluded, nothing sent.
  const ai = { generate: async ({ parse }) => ({ target: 'fake:m', data: parse('{"verdict":"skip","flags":["share"],"summary":"Only a share.","checks":[]}') }) };
  const s = await runScan({ store, sources: demoSources(portals.base), settings: settings(), ai, channels: [c.channel], ...quiet });
  assert.equal(c.sent.length, 0);
  assert.equal(s.alerts, 0);
  assert.ok(store.deals({ status: ['excluded'] }).length >= 4);
  store.close();
});
