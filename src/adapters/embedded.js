// Embedded app state: Next.js __NEXT_DATA__, window.__INITIAL_STATE__ / __PRELOADED_STATE__ / __APOLLO_STATE__,
// and <script type="application/json">. Finds the array that looks most like a list of listings and maps
// fields by key name. A source can pin exact paths with "fieldMap" when the guess is wrong.

const STATE_VARS = /window\.(__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__|__REDUX_STATE__|__DATA__|__APP_STATE__|__SERVER_DATA__|INITIAL_STATE|initialState|__NUXT_DATA__)\s*=\s*/;

/** All JSON blobs embedded in the page. */
export function embeddedJson($, html) {
  const blobs = [];
  $('script#__NEXT_DATA__, script[type="application/json"], script[data-state], script#__NUXT_DATA__').each((_, el) => {
    const txt = $(el).contents().text().trim();
    if (txt.length > 50) { try { blobs.push(JSON.parse(txt)); } catch { /* not JSON */ } }
  });
  $('script:not([src])').each((_, el) => {
    const txt = $(el).contents().text();
    const m = txt.match(STATE_VARS);
    if (!m) return;
    const start = txt.indexOf('{', m.index + m[0].length - 1);
    const json = sliceBalanced(txt, start);
    if (json) { try { blobs.push(JSON.parse(json)); } catch { /* JS object, not JSON */ } }
  });
  void html;
  return blobs;
}

/** Cut a balanced {...} from a string, respecting strings. */
function sliceBalanced(s, start) {
  if (start < 0 || s[start] !== '{') return null;
  let depth = 0;
  let inStr = false;
  let q = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === q) inStr = false;
    } else if (c === '"' || c === "'") { inStr = true; q = c; }
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

export const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Each field: regexes in priority order (the first regex that finds a value wins).
const KEYS = {
  price: [/^(price|askingprice|listprice|listingprice|saleprice|purchaseprice|kaufpreis|prix|precio|priceamount|pricevalue|price_value)$/i, /^(amount|prices|rent|monthlyrent|totalprice)$/i],
  priceLabel: [/^(pricelabel|priceformatted|formattedprice|displayprice|pricetext|price_label|pricestring|abbreviatedprice)$/i],
  currency: [/^(currency|currencycode|pricecurrency)$/i],
  area: [/^(livingarea|living_area|livingspace|floorsize|floorarea|propertysize|displaysize|usablearea|builtuparea|built_up_area|wohnflaeche|habitablesurface|surfacehabitable|areasqm|area_m2|sizesqft|squaremeters|squarefeet)$/i, /^(area|size|surface|surfacearea|sqm|sqft|m2)$/i],
  areaUnit: [/^(areaunit|sizeunit|unitofmeasure|areaunitcode|unit)$/i],
  rooms: [/^(rooms|roomcount|numberofrooms|numrooms|zimmer|pieces|nbrooms|room)$/i],
  bedrooms: [/^(bedrooms|numbedrooms|numberofbedrooms|bedroomcount|beds|bedroom|bed)$/i],
  title: [/^(title|headline|seotitle|listingtitle|subject)$/i, /^(name|displayname)$/i],
  typeText: [/^(propertytypefulldescription|typedescription|propertydescriptiontitle)$/i],
  url: [/^(url|href|link|permalink|detailurl|detailsurl|propertyurl|listingurl|shareurl|share_url|canonicalurl|absoluteurl|weburl|publicurl|seourl|seofriendlypath|seopath|detailpath|listingpath|canonicalpath)$/i, /^(path|slug)$/i],
  id: [/^(id|listingid|propertyid|externalid|adid|exposeid|uuid|_id|zpid)$/i],
  city: [/^(city|town|locality|addresslocality|municipality|ort|ville|ciudad)$/i],
  district: [/^(district|neighbourhood|neighborhood|quarter|community|subcommunity|suburb|area_name|areaname|stadtteil|quartier|barrio|location_name)$/i],
  address: [/^(displayaddress|fulladdress|formattedaddress|streetaddress|address|addressline)$/i, /^(location)$/i],
  type: [/^(propertytype|property_type|propertysubtype|hometype|realestatetype|objecttype|estatetype)$/i, /^(type|subcategory|category)$/i],
  image: [/^(image|imageurl|mainimage|mainimagesrc|coverimage|photo|thumbnail|thumb|picture|srcurl)$/i, /^(images|photos|media)$/i],
  description: [/^(description|summary|snippet|teaser)$/i, /^(text|body)$/i],
  dealType: [/^(dealtype|transactiontype|offertype|listingtype|saletype|purpose|contracttype|marketingtype|channel)$/i],
};

// Values under these keys describe the agent / seller / developer, not the property.
const NOT_PROPERTY = /^(seller|agent|agency|broker|contact|developer|advertiser|company|realtor|office|branch|customer|owner|user|publisher|pagebranding|branding|logo|similar|recommended)/i;

/** Flatten an object two levels deep: { "price.value": 1, "address.city": "x" }. */
function flatten(obj, prefix = '', depth = 0, out = {}) {
  if (!obj || typeof obj !== 'object' || depth > 2) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (NOT_PROPERTY.test(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, depth + 1, out);
    else out[key] = v;
    if (Array.isArray(v) && v.length && typeof v[0] !== 'object') out[key] = v[0];
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && depth < 2) flatten(v[0], `${key}.0`, depth + 1, out);
  }
  return out;
}

const LEAF = /^(value|amount|raw|min|from|formatted|text|label|display|displayprice|name|url|src|srcurl)$/i;

/** Pick a flattened value: regexes in priority order, shallow keys first; "{ price: { value } }" matches on the parent. */
function pick(flat, res, test = () => true) {
  const entries = Object.entries(flat).sort((a, b) => a[0].split('.').length - b[0].split('.').length);
  for (const re of [].concat(res)) {
    for (const [k, v] of entries) {
      if (v === null || v === undefined || v === '') continue;
      const segs = k.split('.').filter((s) => !/^\d+$/.test(s));
      const last = segs[segs.length - 1];
      const parent = segs[segs.length - 2];
      if ((re.test(last) || (parent && re.test(parent) && LEAF.test(last))) && test(v)) return v;
    }
  }
  return undefined;
}

const isNumLike = (v) => typeof v === 'number' || (typeof v === 'string' && /\d/.test(v) && v.length < 60);
const isUrlLike = (v) => typeof v === 'string' && (/^https?:\/\//.test(v) || /^\/[^\s]{2,}/.test(v));

function looksLikeListing(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 0;
  const flat = flatten(o);
  let score = 0;
  if (pick(flat, KEYS.price, isNumLike) !== undefined) score += 3;
  if (pick(flat, KEYS.area, isNumLike) !== undefined) score += 2;
  if (pick(flat, KEYS.rooms, isNumLike) !== undefined || pick(flat, KEYS.bedrooms, isNumLike) !== undefined) score += 1;
  if (pick(flat, KEYS.url, isUrlLike) !== undefined || pick(flat, KEYS.id) !== undefined) score += 1;
  if (pick(flat, KEYS.title) !== undefined || pick(flat, KEYS.address) !== undefined) score += 1;
  return score;
}

/** Find candidate arrays of listing-like objects anywhere in the blob. */
export function findListingArrays(root) {
  const found = [];
  const seen = new Set();
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 14 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length >= 2 && typeof node[0] === 'object') {
        const sample = node.slice(0, 12);
        const scores = sample.map(looksLikeListing);
        const good = scores.filter((s) => s >= 5).length;
        if (good / sample.length >= 0.6) found.push({ path, items: node, score: scores.reduce((a, b) => a + b, 0) / sample.length });
      }
      node.forEach((n, i) => walk(n, `${path}.${i}`, depth + 1));
      return;
    }
    // Apollo/normalized state: an object map of id -> listing
    const vals = Object.values(node);
    if (vals.length >= 3 && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const sample = vals.slice(0, 12);
      const good = sample.filter((v) => looksLikeListing(v) >= 5).length;
      if (good / sample.length >= 0.6) found.push({ path: `${path}.*`, items: vals, score: 5 });
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(root, '', 0);
  // Prefer the biggest, best-scoring list; nested duplicates (a.items vs a.items.0.similar) lose on size.
  return found.sort((a, b) => b.items.length * b.score - a.items.length * a.score);
}

function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.name || v.label || v.text || v.value || v.displayName || null;
  return null;
}

const dealTypeOf = (v) => (!v ? null : /rent|let|lease|miet|louer|alquiler|ايجار/i.test(v) ? 'rent' : /sale|sell|buy|kauf|vente|venta|بيع/i.test(v) ? 'sale' : null);

/** { listing: {...} } or { property: {...}, meta } wrappers -> the inner object. */
function unwrap(o) {
  const objs = Object.entries(o).filter(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) && !NOT_PROPERTY.test(k));
  if (Object.keys(o).length <= 3 && objs.length === 1 && looksLikeListing(objs[0][1]) > looksLikeListing(o)) return objs[0][1];
  return o;
}

/** Coordinates: { latitude, longitude } / { lat, lng|lon } / GeoJSON { type: "Point", coordinates: [lng, lat] }. */
export function geoOf(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 3) return null;
  const lat = o.latitude ?? o.lat;
  const lng = o.longitude ?? o.lng ?? o.lon ?? o.long;
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== null && lng !== null && lat !== '' && lng !== '') return { lat: Number(lat), lng: Number(lng) };
  if (o.type === 'Point' && Array.isArray(o.coordinates) && o.coordinates.length >= 2) return { lat: Number(o.coordinates[1]), lng: Number(o.coordinates[0]) };
  for (const [k, v] of Object.entries(o)) {
    if (NOT_PROPERTY.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const g = geoOf(v, depth + 1);
    if (g) return g;
  }
  return null;
}

/**
 * Attribute lists: [{ key: "size", value: 148 }, { name: "rooms", value: "3" }] (Avito, OLX, Bayut, many
 * classifieds) -> { size: 148, rooms: "3" }, found up to 3 levels deep.
 */
export function attributesOf(o, depth = 0, out = {}) {
  if (!o || typeof o !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(o)) {
    if (NOT_PROPERTY.test(k) || !v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === 'object' && (x.key ?? x.name ?? x.code ?? x.id) != null && (x.value ?? x.values) !== undefined)) {
        for (const x of v) {
          const name = String(x.key ?? x.code ?? x.name ?? x.id).replace(/[^a-z0-9]/gi, '');
          const value = Array.isArray(x.values) ? x.values[0] : x.value;
          if (name && out[name] === undefined && (typeof value !== 'object' || value === null)) out[name] = x.unit && typeof value === 'number' ? `${value} ${x.unit}` : value;
        }
      }
    } else attributesOf(v, depth + 1, out);
  }
  return out;
}

function mapItem(item, fieldMap = {}) {
  const o = fieldMap.list ? item : unwrap(item);
  // Attribute-list values go in as "_attr.size" etc.: matched by their key, after the item's own fields.
  const flat = { ...flatten(o), ...Object.fromEntries(Object.entries(attributesOf(o)).map(([k, v]) => [`_attr.${k}`, v])) };
  const f = (name, test) => (fieldMap[name] ? getPath(o, fieldMap[name]) : pick(flat, KEYS[name], test));
  const geo = fieldMap.lat ? { lat: getPath(o, fieldMap.lat), lng: getPath(o, fieldMap.lng) } : geoOf(o) || {};
  let image = f('image');
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === 'object') image = image.url || image.src || image.href || null;
  const urlOrPath = f('url', isUrlLike);
  return {
    id: textOf(f('id')),
    url: urlOrPath || null,
    title: textOf(f('title')) || [textOf(f('typeText')), textOf(f('address'))].filter(Boolean).join(' – ') || null,
    price: f('price', isNumLike),
    priceText: textOf(f('priceLabel')),
    currency: textOf(f('currency')),
    area: f('area', isNumLike),
    areaUnit: textOf(f('areaUnit')),
    rooms: f('rooms', isNumLike),
    bedrooms: f('bedrooms', isNumLike),
    city: textOf(f('city')),
    district: textOf(f('district')),
    address: textOf(f('address')),
    type: textOf(f('type')),
    image: typeof image === 'string' ? image : null,
    description: textOf(f('description')),
    dealType: dealTypeOf(textOf(f('dealType'))),
    lat: geo.lat ?? null,
    lng: geo.lng ?? null,
    _method: 'embedded',
  };
}

/**
 * Extract listings from embedded JSON. `source.fieldMap` = { list: "props.pageProps.results", price: "price.amount", ... }
 * pins the list path and any field paths; without it everything is detected.
 */
export function extractEmbedded($, html, source = {}) {
  const blobs = embeddedJson($, html);
  const fm = source.fieldMap || {};
  for (const blob of blobs) {
    let items = null;
    if (fm.list) {
      const v = getPath(blob, fm.list);
      items = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : null;
    } else {
      items = findListingArrays(blob)[0]?.items || null;
    }
    if (!items?.length) continue;
    const out = items.map((o) => mapItem(o, fm)).filter((r) => r.price != null && (r.url || r.id));
    if (out.length) return out;
  }
  return [];
}
