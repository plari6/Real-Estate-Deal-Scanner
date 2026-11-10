import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, distanceKm, evaluateListing, marketSummary, stats } from '../src/market.js';
import { fingerprint } from '../src/normalize.js';

const SETTINGS = { minComps: 5, marketStat: 'median', dealThreshold: 0.2, suspiciousThreshold: 0.55, excludeFlags: ['share', 'price_from', 'rent_to_own', 'auction'], geoRadiusKm: 1.5, maxSpread: 0.4, sizeRange: 0.6, localOnly: true };

let n = 0;
function L(o = {}) {
  const l = { uid: `t:${++n}`, deal_type: 'sale', currency: 'EUR', city: 'Berlin', district: 'Mitte', property_type: 'apartment', rooms: 2, area_m2: 60, flags: [], ...o };
  l.price = o.price ?? Math.round(l.area_m2 * (o.ppm2 ?? 7000));
  l.price_m2 = l.area_m2 ? l.price / l.area_m2 : null;
  l.fingerprint = o.fingerprint === undefined ? fingerprint(l) : o.fingerprint;
  return l;
}
// 8 comps around 7 000 €/m² (+-5 %), each a different flat.
const comps = (o = {}) => [0.95, 0.97, 0.99, 1, 1, 1.01, 1.03, 1.05].map((f, i) => L({ ppm2: 7000 * f, area_m2: 55 + i, ...o }));

test('stats: median, trimmed mean, spread', () => {
  const s = stats([1, 2, 3, 4, 100]);
  assert.equal(s.median, 3);
  assert.equal(s.n, 5);
  assert.ok(s.mean > 20);
  assert.equal(stats([]), null);
});

test('a listing 30 % below the district median is a deal with a score', () => {
  const pool = comps();
  const subject = L({ ppm2: 4900 });
  const ev = evaluateListing(subject, buildIndex([...pool, subject]), SETTINGS);
  assert.equal(ev.status, 'deal');
  assert.equal(ev.level, 'district+rooms');
  assert.equal(ev.comps, 8); // leave-one-out: the subject is not its own comparable
  assert.ok(Math.abs(ev.discount - 0.3) < 0.01);
  assert.equal(ev.estimatedValue, 420000);
  assert.ok(ev.savings > 120000);
  assert.ok(ev.score >= 60 && ev.score <= 100);
  assert.ok(ev.confidence > 0.6);
});

test('fair price, suspicious data error and excluded flags', () => {
  const pool = comps();
  assert.equal(evaluateListing(L({ ppm2: 6500 }), buildIndex(pool), SETTINGS).status, 'fair');
  const err = evaluateListing(L({ ppm2: 1500 }), buildIndex(pool), SETTINGS);
  assert.equal(err.status, 'suspicious');
  assert.ok(err.score <= 40);
  const auction = evaluateListing(L({ ppm2: 4500, flags: ['auction'] }), buildIndex(pool), SETTINGS);
  assert.equal(auction.status, 'excluded');
  const reno = evaluateListing(L({ ppm2: 4500, flags: ['renovation'] }), buildIndex(pool), SETTINGS);
  assert.equal(reno.status, 'deal');
  const clean = evaluateListing(L({ ppm2: 4500 }), buildIndex(pool), SETTINGS);
  assert.ok(reno.score < clean.score, 'red flags lower the score');
  assert.equal(evaluateListing(L({ ppm2: 4500 }), buildIndex(pool), { ...SETTINGS, maxPrice: 200000 }).status, 'excluded');
});

test('falls back from district+rooms to district, and to nearby (GPS) comparables first', () => {
  const pool = comps({ rooms: 3 }); // other room count -> district level
  const ev = evaluateListing(L({ ppm2: 4900, rooms: 2 }), buildIndex(pool), SETTINGS);
  assert.equal(ev.level, 'district');
  const geoPool = comps({ lat: 52.52, lng: 13.405, district: 'Somewhere' });
  const near = evaluateListing(L({ ppm2: 4900, lat: 52.521, lng: 13.406, district: 'Other name' }), buildIndex(geoPool), SETTINGS);
  assert.equal(near.level, 'nearby+rooms');
  assert.match(near.segment, /within 1.5 km/);
  const far = comps({ lat: 52.40, lng: 13.10, district: 'Far' }); // ~25 km away
  assert.equal(evaluateListing(L({ ppm2: 4900, lat: 52.52, lng: 13.405, district: 'X' }), buildIndex(far), SETTINGS).status, 'unrated');
  assert.ok(Math.abs(distanceKm({ lat: 52.52, lng: 13.405 }, { lat: 52.5, lng: 13.4 }) - 2.25) < 0.1);
});

test('never compares a located listing with a city-wide average (localOnly), unless it has no location', () => {
  const cityPool = comps({ district: 'Elsewhere' });
  const located = evaluateListing(L({ ppm2: 4900, district: 'Mitte' }), buildIndex(cityPool), SETTINGS);
  assert.equal(located.status, 'unrated');
  // No location, in a city where other listings have districts: cannot tell cheap area from bargain.
  const unknown = evaluateListing(L({ ppm2: 4900, district: null }), buildIndex(cityPool), SETTINGS);
  assert.equal(unknown.status, 'unrated');
  assert.match(unknown.reasons[0], /location unknown/);
  // A market where no listing has a location (one small town): the town-wide average is the right one.
  const town = evaluateListing(L({ ppm2: 4900, district: null }), buildIndex(comps({ district: null })), SETTINGS);
  assert.equal(town.level, 'city+rooms');
  assert.equal(town.status, 'deal');
  assert.equal(evaluateListing(L({ ppm2: 4900 }), buildIndex(cityPool), { ...SETTINGS, localOnly: false }).level, 'city+rooms');
});

test('spread guard: a group whose prices vary wildly is not a market', () => {
  const mixed = [0.4, 0.6, 0.8, 1, 1.2, 1.5, 1.9, 2.4].map((f, i) => L({ ppm2: 7000 * f, area_m2: 55 + i }));
  const ev = evaluateListing(L({ ppm2: 4000 }), buildIndex(mixed), SETTINGS);
  assert.equal(ev.status, 'unrated');
  assert.match(ev.reasons[0], /too mixed/);
});

test('size matters: a 300 m² villa is not compared with 60 m² flats', () => {
  const pool = comps({ district: 'Mitte' });
  const big = evaluateListing(L({ area_m2: 300, rooms: 6, ppm2: 4000 }), buildIndex(pool), SETTINGS);
  assert.equal(big.status, 'unrated');
});

test('duplicates (same flat on two portals) count once; rent and sale never mix', () => {
  const base = L({ ppm2: 7000 });
  const dups = Array.from({ length: 6 }, () => L({ ppm2: 7000, area_m2: base.area_m2, price: base.price, fingerprint: base.fingerprint }));
  const ev = evaluateListing(L({ ppm2: 4900, area_m2: 61 }), buildIndex([base, ...dups]), SETTINGS);
  assert.equal(ev.status, 'unrated', '7 copies of one flat are 1 comparable');
  const rents = comps({ deal_type: 'rent', ppm2: 20 });
  assert.equal(evaluateListing(L({ ppm2: 4900 }), buildIndex(rents), SETTINGS).status, 'unrated');
});

test('listings without area are compared by total price within the same room band', () => {
  const pool = [0.95, 0.98, 1, 1.02, 1.05, 1].map((f) => L({ area_m2: null, price: 400000 * f, rooms: 2 }));
  const ev = evaluateListing(L({ area_m2: null, price: 280000, rooms: 2 }), buildIndex(pool), SETTINGS);
  assert.equal(ev.metric, 'price');
  assert.equal(ev.status, 'deal');
  assert.equal(evaluateListing(L({ area_m2: null, rooms: null, price: 1 }), buildIndex(pool), SETTINGS).status, 'unrated');
});

test('bad comparables (auction, share, price from) are left out of the average', () => {
  const pool = [...comps(), ...Array.from({ length: 10 }, () => L({ ppm2: 2000, flags: ['auction'] }))];
  const ev = evaluateListing(L({ ppm2: 4900 }), buildIndex(pool), SETTINGS);
  assert.equal(ev.comps, 8);
  assert.equal(ev.status, 'deal');
});

test('marketSummary groups by city and district', () => {
  const rows = marketSummary([...comps(), ...comps({ district: 'Kreuzberg', ppm2: 6000 })]);
  const kb = rows.find((r) => r.district === 'Kreuzberg');
  assert.ok(Math.abs(kb.median - 6000) < 100);
  assert.ok(rows.find((r) => r.district === 'All districts').n >= 16);
});
