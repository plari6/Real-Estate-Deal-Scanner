// Raw adapter output -> one clean listing record (numbers, m², location, uid, fingerprint).
import { cleanUrl, detectCurrency, detectDealType, detectType, normText, parseArea, parsePrice, parseRooms } from './parse.js';
import { detectFlags } from './flags.js';

const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const title = (s) => (s ? s.replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);

/** "Oranienstr. 12, 10999 Berlin-Kreuzberg" + city "Berlin" -> "Kreuzberg". */
export function guessDistrict(address, city) {
  if (!address) return null;
  const c = normText(city);
  const parts = String(address)
    .split(/[,|·•\n]/)
    .map((p) => p.replace(/\b\d{4,6}\b/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const n = normText(p);
    if (c && n === c) continue;
    if (c && n.startsWith(`${c}-`)) { out.push(p.slice(c.length + 1).trim()); continue; }
    out.push(p);
  }
  // Counties / states / countries are too broad to be a district ("Co. Dublin", "Greater London").
  const broad = /^(co\.?|county|greater|state of|region|province|england|scotland|wales|ireland|united kingdom|uk|usa|germany|deutschland|france|spain|uae)\b/i;
  const noDigits = out.filter((p) => !/\d/.test(p) && !broad.test(p));
  // UK outward postcodes (SW3, E14) and Irish postal districts (Dublin 14) are good district keys.
  const postal = out.find((p) => /^[A-Z]{1,2}\d[A-Z\d]?$/.test(p) || (c && new RegExp(`^${c} \\d{1,2}w?$`).test(normText(p))));
  if (postal && noDigits.length < 2) return clip(postal, 60);
  return clip(noDigits[noDigits.length - 1] || null, 60);
}

const NOT_PLACE = /^(vendre|venda|venta|louer|sale|rent|let|verkauf|vermieten|der|la|le|the|a|an|centre|center|zentrum|ville|city|bon|tres|très|bonne|excellent)$/i;

/** Last-resort district from titles like "Appartement à vendre à Californie" / "Flat in Kreuzberg". */
export function districtFromTitle(t, city) {
  if (!t) return null;
  const c = normText(city);
  const re = /(?:^|\s)(?:à|a|in|en|im|in der|au|aux|al|el|في|بـ)\s+([A-ZÀ-ÖØ-Þ\u0600-\u06ff][\p{L}'’-]+(?:\s+(?:[A-ZÀ-ÖØ-Þ][\p{L}'’-]+|de|du|des|el|al))*(?:\s+[A-ZÀ-ÖØ-Þ][\p{L}'’-]+)?)/gu;
  let best = null;
  for (const m of String(t).matchAll(re)) {
    const name = m[1].replace(/[.,;:!]+$/, '').trim();
    if (NOT_PLACE.test(name) || normText(name) === c) continue;
    best = name;
  }
  return best ? best.slice(0, 60) : null;
}

function guessCity(address, fallback) {
  if (fallback) return fallback;
  if (!address) return null;
  const parts = String(address).split(',').map((p) => p.replace(/\b\d{4,6}\b/g, '').trim()).filter((p) => p && !/\d/.test(p));
  return clip(parts[parts.length - 1] || null, 60);
}

function areaUnitOf(u, fallback) {
  if (!u) return fallback || 'm2';
  return /ft|sf|feet|FTK/i.test(u) ? 'sqft' : /yd/i.test(u) ? 'sqyd' : 'm2';
}

/** Stable id: the portal id when known, else the URL path (query kept only when it carries the id). */
export function listingUid(sourceName, raw, url) {
  if (raw.id) return `${sourceName}:${String(raw.id).slice(0, 80)}`;
  const u = new URL(url);
  const keep = [...u.searchParams.entries()].filter(([k]) => /^(id|listing|property|expose|ad|pid|lid)/i.test(k));
  return `${sourceName}:${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${keep.length ? `?${new URLSearchParams(keep)}` : ''}`;
}

/**
 * Normalize one raw listing. Returns null when it has no link or no usable price.
 * @param {object} raw  adapter output
 * @param {{source: object, pageUrl: string, currency?: string}} ctx
 */
export function normalizeListing(raw, { source, pageUrl, currency = 'EUR' }) {
  const d = source.defaults || {};
  let href = raw.url;
  if ((!href || href === pageUrl) && raw.id && source.urlTemplate) href = source.urlTemplate.replaceAll('{id}', encodeURIComponent(raw.id));
  const url = cleanUrl(href, pageUrl);
  if (!url) return null;

  // Portals write currencies as "€", "DH", "Dhs", "AED": map them to ISO codes.
  const rawCur = raw.currency ? (/^[A-Z]{3}$/.test(String(raw.currency).trim()) ? String(raw.currency).trim() : detectCurrency(` ${raw.currency} `, null)) : null;
  const cur = rawCur || d.currency || currency;
  const priceInfo = parsePrice(raw.price, { currency: cur }) || parsePrice(raw.priceText, { currency: cur });
  if (!priceInfo) return null;
  const labelPeriod = raw.priceText ? parsePrice(raw.priceText, {})?.period : null;
  const period = priceInfo.period || labelPeriod || null;
  const ctxText = [raw.title, raw.priceText, raw.type, raw.description?.slice(0, 300)].filter(Boolean).join(' ');
  const dealType = raw.dealType || detectDealType(ctxText, { period, fallback: d.dealType || 'sale' });
  // Rent is compared per month.
  const price = dealType === 'rent' && period === 'year' ? Math.round(priceInfo.amount / 12) : priceInfo.amount;

  const area_m2 = parseArea(raw.area, areaUnitOf(raw.areaUnit, d.areaUnit)) ?? parseArea(raw._text || '', 'm2') ?? parseArea(raw.title || '', 'm2');
  const rooms = parseRooms(raw.rooms) ?? parseRooms(raw.bedrooms);
  // Some portals use the address as the title ("34 Whitethorn Road, Clonskeagh, Dublin 14").
  const addr = raw.address || (raw.title && raw.title.split(',').length >= 2 ? raw.title.replace(/^.*?\s[–-]\s/, '') : null);
  const city = title(clip(raw.city, 60) || guessCity(addr, d.city) || null);
  const district = title(clip(raw.district, 60) || d.district || guessDistrict(addr, city) || districtFromTitle(raw.title, city));
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const hasGeo = raw.lat != null && raw.lng != null && raw.lat !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  // The portal's own type field wins; the title can mislead ("Flat in Salisbury House").
  const property_type = detectType(raw.type, null) || detectType(raw.title, null) || d.type || 'apartment';

  const listing = {
    uid: listingUid(source.name, raw, url),
    source: source.name,
    url,
    title: clip(raw.title, 200),
    price,
    currency: priceInfo.currency || d.currency || currency,
    deal_type: dealType,
    area_m2,
    rooms,
    property_type,
    city,
    district,
    address: clip(raw.address, 200),
    lat: hasGeo ? Math.round(lat * 1e6) / 1e6 : null,
    lng: hasGeo ? Math.round(lng * 1e6) / 1e6 : null,
    image: raw.image ? cleanUrl(raw.image, pageUrl) : null,
    description: clip(raw.description, 2000),
    priceText: clip(raw.priceText, 80),
    price_m2: area_m2 ? Math.round((price / area_m2) * 100) / 100 : null,
    method: raw._method || null,
  };
  listing.flags = detectFlags(listing);
  listing.fingerprint = fingerprint(listing);
  return listing;
}

/** Same flat on two portals (or by two agents) -> same fingerprint, so it counts once in the market average. */
export function fingerprint(l) {
  if (!l.area_m2) return null;
  return [normText(l.city), l.deal_type, l.property_type, Math.round(l.area_m2), l.rooms ?? '', Math.round(l.price / 1000)].join('|');
}
