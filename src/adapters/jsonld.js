// schema.org JSON-LD: RealEstateListing, Offer/AggregateOffer, Apartment, House, SingleFamilyResidence,
// Residence, Product, ItemList. Many portals embed this for Google, so it is the most stable source.

const HOME_TYPES = /^(RealEstateListing|Offer|Product|Apartment|House|SingleFamilyResidence|Residence|Accommodation|ApartmentComplex|Place|Room|Suite|Landform|LandmarksOrHistoricalBuildings|Hotel)$/;

export function parseJsonLdBlocks($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text().trim();
    if (!txt) return;
    try {
      out.push(JSON.parse(txt));
    } catch {
      // Some sites put several objects or trailing commas in one block; try a light repair.
      try { out.push(JSON.parse(`[${txt.replace(/}\s*{/g, '},{').replace(/,\s*([\]}])/g, '$1')}]`)); } catch { /* skip */ }
    }
  });
  return out;
}

const types = (o) => [].concat(o?.['@type'] || []).map(String);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const val = (v) => (v && typeof v === 'object' ? v.value ?? v['@value'] ?? v.name ?? null : v);

function offerOf(o) {
  const offers = first(o.offers) || (types(o).includes('Offer') ? o : null);
  if (!offers) return {};
  const spec = first(offers.priceSpecification);
  const price = offers.price ?? offers.lowPrice ?? spec?.price ?? spec?.minPrice;
  return { price, currency: offers.priceCurrency || spec?.priceCurrency, unitText: spec?.unitText || spec?.referenceQuantity?.unitText || offers.unitText };
}

function areaOf(o) {
  const fs = o.floorSize || o.livingArea || o.size;
  if (fs == null) return {};
  if (typeof fs !== 'object') return { area: fs };
  const code = String(fs.unitCode || fs.unitText || '').toUpperCase();
  return { area: fs.value ?? fs.minValue, areaUnit: /FTK|FT|SQFT|SQ FT/.test(code) ? 'sqft' : 'm2' };
}

function addressOf(o) {
  const a = first(o.address) || first(o.location)?.address || first(o.contentLocation)?.address;
  if (!a) return {};
  if (typeof a === 'string') return { address: a };
  return {
    address: [a.streetAddress, a.postalCode, a.addressLocality].filter(Boolean).join(', ') || null,
    city: a.addressLocality || null,
    district: a.addressNeighborhood || a.neighborhood || null,
    region: a.addressRegion || null,
  };
}

/** Turn one schema.org node (+ the thing it offers) into a raw listing, or null. */
function toRaw(node, pageUrl) {
  const item = node.itemOffered ? first(node.itemOffered) : node.about ? first(node.about) : node.mainEntity ? first(node.mainEntity) : node;
  const merged = { ...item, ...node, offers: node.offers || item.offers || (types(node).includes('Offer') ? node : undefined) };
  const { price, currency, unitText } = offerOf(merged);
  if (price == null || price === '') return null;
  const { area, areaUnit } = areaOf(item.floorSize ? item : merged);
  const url = merged.url || item.url || merged['@id'];
  const geo = first(item.geo) || first(merged.geo) || first(item.location)?.geo || first(merged.contentLocation)?.geo || {};
  return {
    lat: geo.latitude ?? null,
    lng: geo.longitude ?? null,
    url: typeof url === 'string' && !url.startsWith('_:') ? url : pageUrl,
    title: val(merged.name) || val(item.name) || null,
    price,
    priceText: unitText ? `${price} ${unitText}` : null,
    currency,
    area,
    areaUnit,
    rooms: val(item.numberOfRooms) ?? val(merged.numberOfRooms) ?? null,
    bedrooms: val(item.numberOfBedrooms ?? item.numberOfBedroomsTotal) ?? null,
    ...addressOf(item.address ? item : merged),
    type: [...types(item), ...types(merged)].join(' '),
    image: typeof first(merged.image) === 'string' ? first(merged.image) : first(merged.image)?.url || null,
    description: merged.description || item.description || null,
    _method: 'jsonld',
  };
}

export function extractJsonLd($, pageUrl) {
  const results = [];
  const seen = new Set();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    const t = types(node);
    if (t.includes('ItemList') || t.includes('SearchResultsPage') || t.includes('CollectionPage')) {
      for (const el of [].concat(node.itemListElement || node.mainEntity?.itemListElement || [])) visit(el.item || el, depth + 1);
      if (node.mainEntity) visit(node.mainEntity, depth + 1);
      return;
    }
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (t.some((x) => HOME_TYPES.test(x)) || node.offers || node.itemOffered) {
      const raw = toRaw(node, pageUrl);
      if (raw) {
        const key = `${raw.url}|${raw.price}`;
        if (!seen.has(key)) { seen.add(key); results.push(raw); }
        return;
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, depth + 1);
  };
  for (const block of parseJsonLdBlocks($)) visit(block);
  // A single result that just points back at the search page is a page-level Offer, not a listing.
  return results.length === 1 && results[0].url === pageUrl && !results[0].area ? [] : results;
}
