// Market value engine. For each listing it finds comparable listings (same deal type, currency, city and
// property type; then district and room count when there are enough of them), takes a robust average of
// their price per m², and measures how far below that the listing is priced.
import { normText, roomsBand } from './parse.js';

// Comparable groups from the most specific to the broadest. The first level with enough comps whose
// prices are not too mixed (spread <= MAX_SPREAD) is the market. GPS levels need coordinates on both sides.
const rb = (l) => `${roomsBand(l.rooms)} room${roomsBand(l.rooms) === '1' ? '' : 's'}`;
const km = (r) => (r < 1 ? `${Math.round(r * 1000)} m` : `${Math.round(r * 10) / 10} km`);
const LEVELS_AREA = [
  { level: 'nearby+rooms', geo: 1, needs: ['geo', 'rooms'], weight: 1, label: (l, r) => `within ${km(r)} · ${l.property_type} · ${rb(l)}` },
  { level: 'nearby', geo: 1, needs: ['geo'], weight: 0.95, label: (l, r) => `within ${km(r)} · ${l.property_type}` },
  { level: 'district+rooms', needs: ['district', 'rooms'], weight: 0.95, label: (l) => `${l.district} · ${l.property_type} · ${rb(l)}` },
  { level: 'district', needs: ['district'], weight: 0.9, label: (l) => `${l.district} · ${l.property_type}` },
  { level: 'nearby-wide', geo: 2, needs: ['geo'], weight: 0.85, label: (l, r) => `within ${km(r)} · ${l.property_type}` },
  { level: 'city+rooms', needs: ['rooms'], weight: 0.8, label: (l) => `${l.city} · ${l.property_type} · ${rb(l)}` },
  { level: 'city', needs: [], weight: 0.7, label: (l) => `${l.city} · ${l.property_type}` },
];
// Without a living area only same-size (room count) groups are fair to compare on total price.
const LEVELS_PRICE = LEVELS_AREA.filter((x) => x.needs.includes('rooms'));

/** Distance in km between two { lat, lng }. */
export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
const hasGeo = (l) => l.lat != null && l.lng != null;

// Flags that make a listing a bad comparable (its price is not a full market price).
const NOT_A_COMP = new Set(['share', 'price_from', 'rent_to_own', 'auction']);

const FLAG_PENALTY = { auction: 15, share: 25, price_from: 20, rent_to_own: 25, tenanted: 8, renovation: 8, leasehold: 10, off_plan: 6, no_area: 6 };

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return null;
  const q = (p) => {
    const i = (n - 1) * p;
    const lo = Math.floor(i);
    return v[lo] + (v[Math.min(lo + 1, n - 1)] - v[lo]) * (i - lo);
  };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const cut = Math.floor(n * 0.1);
  const t = v.slice(cut, n - cut);
  const trimmed = t.reduce((a, b) => a + b, 0) / t.length;
  const median = q(0.5);
  return { n, min: v[0], max: v[n - 1], mean, median, trimmed, p25: q(0.25), p75: q(0.75), spread: median ? (q(0.75) - q(0.25)) / median : 0 };
}

const baseKey = (l) => [l.deal_type, l.currency, normText(l.city), l.property_type].join('|');

/** Index comparable candidates once per scan: baseKey -> listings. */
export function buildIndex(listings) {
  const idx = new Map();
  for (const l of listings) {
    if (!l.price || !l.city) continue;
    if ((l.flags || []).some((f) => NOT_A_COMP.has(f))) continue;
    const k = baseKey(l);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(l);
  }
  return idx;
}

function matches(comp, l, needs, radiusKm) {
  if (needs.includes('district') && (!l.district || normText(comp.district) !== normText(l.district))) return false;
  if (needs.includes('rooms') && (l.rooms == null || roomsBand(comp.rooms) !== roomsBand(l.rooms))) return false;
  if (needs.includes('geo') && (!hasGeo(comp) || distanceKm(l, comp) > radiusKm)) return false;
  return true;
}

/**
 * Value one listing against the market.
 * @returns {{status: 'deal'|'suspicious'|'excluded'|'fair'|'unrated', discount?: number, market?: number,
 *   metric?: 'm2'|'price', level?: string, segment?: string, comps: number, estimatedValue?: number,
 *   savings?: number, confidence?: number, score: number, reasons: string[]}}
 */
export function evaluateListing(l, index, settings) {
  const { minComps = 5, marketStat = 'median', dealThreshold = 0.2, suspiciousThreshold = 0.55, excludeFlags = [], geoRadiusKm = 1.5, maxSpread = 0.4, sizeRange = 0.6, localOnly = true } = settings;
  const pool = index.get(baseKey(l)) || [];
  const metric = l.area_m2 ? 'm2' : 'price';
  // When we know where the listing is, only compare it locally: a city-wide average mixes cheap and
  // expensive areas. City levels are for listings without coordinates or district (e.g. one small town).
  // A listing without a location in a city whose other listings have districts/coordinates is not rated
  // either: we cannot tell whether it sits in a cheap or an expensive area.
  const knowsWhere = hasGeo(l) || Boolean(l.district);
  const cityHasAreas = localOnly && pool.some((c) => c.uid !== l.uid && (c.district || hasGeo(c)));
  const cityLevelsOk = !localOnly || (!knowsWhere && !cityHasAreas);
  const levels = (metric === 'm2' ? LEVELS_AREA : LEVELS_PRICE).filter((lv) => cityLevelsOk || !lv.level.startsWith('city'));
  if (!knowsWhere && !cityLevelsOk) return { status: 'unrated', comps: 0, score: 0, reasons: ['location unknown (no district or coordinates): cannot compare with the local market'] };
  // Price per m² falls as homes get bigger, so comparables must be of a similar size (default 0.4x - 1.6x).
  const sizeOk = (c) => metric !== 'm2' || !sizeRange || (c.area_m2 >= l.area_m2 * (1 - sizeRange) && c.area_m2 <= l.area_m2 * (1 + sizeRange));
  const value = metric === 'm2' ? l.price_m2 : l.price;
  const reasons = [];
  if (!l.city) return { status: 'unrated', comps: 0, score: 0, reasons: ['no city/location'] };
  if (metric === 'price' && l.rooms == null) return { status: 'unrated', comps: 0, score: 0, reasons: ['no area and no room count'] };

  let tooMixed = null;
  for (const lv of levels) {
    if (lv.needs.includes('district') && !l.district) continue;
    if (lv.needs.includes('rooms') && l.rooms == null) continue;
    if (lv.needs.includes('geo') && !hasGeo(l)) continue;
    const radius = (lv.geo || 0) * geoRadiusKm;
    // Leave-one-out, and count the same flat listed twice only once.
    const seen = new Set(l.fingerprint ? [l.fingerprint] : []);
    const vals = [];
    for (const c of pool) {
      if (c.uid === l.uid || !matches(c, l, lv.needs, radius) || !sizeOk(c)) continue;
      const v = metric === 'm2' ? c.price_m2 : c.price;
      if (!v) continue;
      if (c.fingerprint) {
        if (seen.has(c.fingerprint)) continue;
        seen.add(c.fingerprint);
      }
      vals.push(v);
    }
    if (vals.length < minComps) continue;

    const s = stats(vals);
    // A group whose prices vary this much (e.g. a whole city) has no meaningful "average": a 20 % gap is normal there.
    if (maxSpread && s.spread > maxSpread) { tooMixed ||= `${lv.label(l, radius)} (spread ${Math.round(s.spread * 100)}%)`; continue; }
    const market = s[marketStat] ?? s.median;
    const discount = 1 - value / market;
    const estimatedValue = metric === 'm2' ? market * l.area_m2 : market;
    // Confidence: specific group, many comps, tight prices, compared per m².
    const compsF = Math.min(1, 0.4 + (0.6 * s.n) / (minComps * 4));
    const spreadF = s.spread <= 0.2 ? 1 : s.spread >= 0.8 ? 0.5 : 1 - ((s.spread - 0.2) / 0.6) * 0.5;
    const confidence = Math.round(lv.weight * compsF * spreadF * (metric === 'm2' ? 1 : 0.75) * 100) / 100;

    const flags = l.flags || [];
    const excluded = flags.filter((f) => excludeFlags.includes(f));
    let status = 'fair';
    if (discount >= dealThreshold) {
      if (discount >= suspiciousThreshold) { status = 'suspicious'; reasons.push(`${Math.round(discount * 100)}% below market: check for a data error (rent vs sale, wrong area, share)`); }
      else if (excluded.length) { status = 'excluded'; reasons.push(`excluded flag: ${excluded.join(', ')}`); }
      else status = 'deal';
      if (settings.minPrice && l.price < settings.minPrice) { status = 'excluded'; reasons.push('below MIN_PRICE'); }
      if (settings.maxPrice && l.price > settings.maxPrice) { status = 'excluded'; reasons.push('above MAX_PRICE'); }
    }

    // Deal score 0-100: depth of discount (max at 40 %), confidence, minus red flag penalties.
    const penalty = flags.reduce((a, f) => a + (FLAG_PENALTY[f] || 0), 0);
    const depth = Math.max(0, Math.min(1, discount / 0.4));
    let score = Math.round(depth * 65 + confidence * 35 - penalty);
    if (status === 'suspicious') score = Math.min(score, 40);
    score = Math.max(0, Math.min(100, score));
    if (status === 'deal' && settings.minScore && score < settings.minScore) { status = 'excluded'; reasons.push(`score ${score} < MIN_SCORE`); }

    return {
      status,
      discount: Math.round(discount * 1000) / 1000,
      market: Math.round(market * 100) / 100,
      metric,
      level: lv.level,
      segment: lv.label(l, radius),
      comps: s.n,
      spread: Math.round(s.spread * 100) / 100,
      estimatedValue: Math.round(estimatedValue),
      savings: Math.round(estimatedValue - l.price),
      confidence,
      score,
      reasons,
    };
  }
  return {
    status: 'unrated',
    comps: 0,
    score: 0,
    reasons: [tooMixed
      ? `no local group with enough comparables; the wider group is too mixed: ${tooMixed}`
      : `fewer than ${minComps} similar listings ${knowsWhere && localOnly ? 'nearby / in the district' : ''} yet (more scans or pages build this up)`.replace('  ', ' ')],
  };
}

/** Market table for reports and the /market command: one row per city · district · type (sale/rent apart). */
export function marketSummary(listings, { minCount = 3 } = {}) {
  const groups = new Map();
  for (const l of listings) {
    if (!l.price_m2 || !l.city || (l.flags || []).some((f) => NOT_A_COMP.has(f))) continue;
    for (const district of [l.district || null, '*']) {
      const key = [l.deal_type, l.currency, l.city, district, l.property_type].join('|');
      if (!groups.has(key)) groups.set(key, { deal_type: l.deal_type, currency: l.currency, city: l.city, district: district === '*' ? 'All districts' : district || '?', property_type: l.property_type, values: [], fps: new Set() });
      const g = groups.get(key);
      if (l.fingerprint && g.fps.has(l.fingerprint)) continue;
      if (l.fingerprint) g.fps.add(l.fingerprint);
      g.values.push(l.price_m2);
    }
  }
  return [...groups.values()]
    .map(({ values, fps, ...g }) => ({ ...g, ...stats(values) }))
    .filter((g) => g.n >= minCount)
    .sort((a, b) => a.city.localeCompare(b.city) || (a.district === 'All districts' ? -1 : b.district === 'All districts' ? 1 : a.district.localeCompare(b.district)) || a.property_type.localeCompare(b.property_type));
}
