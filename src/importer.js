// Import listings from CSV / JSON / JSONL (Apify datasets, portal exports, MLS or CRM dumps).
// Column names are matched loosely: url|link, price, area|size|sqm|sqft, rooms|bedrooms, city, district ...
import fs from 'node:fs';
import path from 'node:path';
import { normalizeListing } from './normalize.js';

/** Small RFC 4180 CSV parser; detects ; , or tab. */
export function parseCsv(text) {
  const src = text.replace(/^\ufeff/, '');
  const firstLine = src.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]?.trim() ?? ''])));
}

const ALIASES = {
  url: /^(url|link|href|listing_?url|detail_?url|permalink)$/i,
  id: /^(id|listing_?id|property_?id|external_?id|zpid|mls)$/i,
  title: /^(title|name|headline)$/i,
  price: /^(price|asking_?price|list_?price|amount|preis|kaufpreis|prix|precio|unformattedprice)$/i,
  currency: /^(currency|cur)$/i,
  area: /^(area|size|living_?area|floor_?area|sqm|m2|surface|wohnflaeche|area_?m2|livingarea)$/i,
  sqft: /^(sqft|sq_?ft|square_?feet|area_?sqft|livingareasqft)$/i,
  rooms: /^(rooms|room_?count|zimmer|pieces)$/i,
  bedrooms: /^(bedrooms|beds|bd)$/i,
  city: /^(city|town|locality|ort|ville)$/i,
  district: /^(district|neighbou?rhood|community|suburb|stadtteil|quartier|area_?name)$/i,
  address: /^(address|location|street|full_?address|addressstreet)$/i,
  type: /^(type|property_?type|home_?type|category)$/i,
  dealType: /^(deal_?type|offer_?type|purpose|listing_?type|status)$/i,
  image: /^(image|image_?url|photo|img|imgsrc|thumbnail)$/i,
  description: /^(description|text|details)$/i,
  lat: /^(lat|latitude)$/i,
  lng: /^(lng|lon|long|longitude)$/i,
};

export function mapRecord(rec) {
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === '' || v == null) continue;
    const key = k.trim().replace(/[\s-]+/g, '_'); // "Listing URL" -> "Listing_URL"
    for (const [field, re] of Object.entries(ALIASES)) if (re.test(key) && out[field] === undefined) out[field] = typeof v === 'object' ? v.url || v.value || JSON.stringify(v) : v;
  }
  if (out.sqft && !out.area) { out.area = out.sqft; out.areaUnit = 'sqft'; }
  if (out.dealType) out.dealType = /rent|let|lease|miet/i.test(out.dealType) ? 'rent' : /sale|sell|buy|kauf|for_sale/i.test(out.dealType) ? 'sale' : null;
  out._method = 'import';
  return out;
}

export function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return parseCsv(text);
  if (ext === '.jsonl' || ext === '.ndjson') return text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const j = JSON.parse(text);
  return Array.isArray(j) ? j : j.listings || j.items || j.results || j.data || [];
}

/** Read a file and return normalized listings (not stored). */
export function importFile(file, { sourceName, defaults = {}, currency = 'EUR' } = {}) {
  const source = { name: sourceName || path.basename(file).replace(/\.\w+$/, ''), defaults };
  const records = readRecords(file);
  const listings = [];
  let skipped = 0;
  for (const rec of records) {
    const raw = mapRecord(rec);
    const l = raw.url ? normalizeListing(raw, { source, pageUrl: raw.url, currency }) : null;
    if (l) listings.push(l);
    else skipped++;
  }
  return { listings, skipped, total: records.length };
}
