// Turns portal text into numbers: prices ("€ 349.000", "AED 1.2M", "1,2 Mio. €", "$2,450/mo"),
// areas ("85,5 m²", "915 sq ft"), rooms ("3 Zimmer", "2 bd", "Studio"), property and deal type.

const CURRENCIES = [
  [/€|\beur\b|euro/i, 'EUR'],
  [/£|\bgbp\b/i, 'GBP'],
  [/\baed\b|\bdhs\b|درهم/i, 'AED'],
  [/\bsar\b|ريال|\bsr\b/i, 'SAR'],
  [/\bqar\b/i, 'QAR'],
  [/\bkwd\b/i, 'KWD'],
  [/\bbhd\b/i, 'BHD'],
  [/\bomr\b/i, 'OMR'],
  [/\begp\b|e£|جنيه/i, 'EGP'],
  [/\bmad\b|\bdh\b/i, 'MAD'],
  [/\bchf\b|\bfr\.\s/i, 'CHF'],
  [/₺|\btry\b|\btl\b/i, 'TRY'],
  [/₹|\binr\b|\brs\.?\s/i, 'INR'],
  [/\bcad\b|c\$/i, 'CAD'],
  [/\baud\b|a\$/i, 'AUD'],
  [/\bpln\b|zł/i, 'PLN'],
  [/\bsek\b|\bnok\b|\bdkk\b|\bkr\b/i, 'SEK'],
  [/\busd\b|us\$|\$/i, 'USD'],
];

const MULTIPLIERS = [
  [/^(k|tsd\.?|thousand|mil(?!l))\b/i, 1e3],
  [/^(m|mn|mio\.?|million|millions|mill\.?|millones|مليون)(?![²2a-z])/i, 1e6],
  [/^(bn|b|billion|mrd\.?|milliard)\b/i, 1e9],
  [/^lakhs?\b|^lacs?\b/i, 1e5],
  [/^crores?\b|^cr\b/i, 1e7],
];

const RENT_PERIOD = /(\/\s*(mo|month|mon|m\b|mth|pcm|week|wk|yr|year|annum))|per\s+(month|week|year|annum)|\bp\.?\s?c\.?\s?m\b|\bp\.?\s?m\.?(?!\w)|\bp\.?\s?a\.?(?!\w)|monthly|yearly|annually|weekly|monatlich|\bmtl\.|kaltmiete|warmmiete|\/\s*mois|par mois|al mes|\/\s*mes|mensual|شهري|سنوي|في الشهر|في السنة/i;
const YEARLY = /yr|year|annum|yearly|annually|p\.?\s?a\.?(?!\w)|سنوي|في السنة/i;
const ON_REQUEST = /on request|upon request|price on application|\bpoa\b|auf anfrage|sur demande|a consultar|consultar precio|contact (agent|us) for price|السعر عند الطلب/i;

/** Strip accents, lowercase, collapse spaces. */
export function normText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectCurrency(text, fallback) {
  const t = String(text ?? '');
  for (const [re, code] of CURRENCIES) if (re.test(t)) return code;
  return fallback;
}

/** "1.299.000" / "1,299,000" / "1 299 000" / "349.000,50" / "1.2" -> number. */
export function parseNumber(raw, { hasMultiplier = false } = {}) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(/[\s\u00a0\u202f'’]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length > 2) s = parts.join(''); // several separators: thousands
    else if (tail.length === 3 && !hasMultiplier && parts[0] !== '0') s = parts.join(''); // "349.000"
    else s = parts.join('.'); // "85,5" or "1.2M"
  }
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a price. Returns { amount, currency, period } (period: null for a sale price,
 * 'month' or 'year' for rent) or null when there is no usable price ("on request").
 */
export function parsePrice(input, { currency } = {}) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return input > 0 ? { amount: input, currency, period: null } : null;
  const text = String(input).replace(/\u00a0/g, ' ');
  if (ON_REQUEST.test(text) && !/\d{3}/.test(text)) return null;
  // First number (with its thousand separators) + an optional multiplier word right after it.
  const m = text.match(/(\d{1,3}(?:[\s.,'’\u202f]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)\s*([a-zA-Z\u0600-\u06ff.]+)?/);
  if (!m) return null;
  const raw = m[1];
  const word = (m[2] || '').trim();
  let mult = 1;
  for (const [re, f] of MULTIPLIERS) if (re.test(word)) { mult = f; break; }
  const n = parseNumber(raw, { hasMultiplier: mult !== 1 });
  if (n === null || n <= 0) return null;
  const amount = Math.round(n * mult * 100) / 100;
  const period = RENT_PERIOD.test(text) ? (YEARLY.test(text.match(RENT_PERIOD)[0]) ? 'year' : 'month') : null;
  return { amount, currency: detectCurrency(text, currency), period };
}

const SQFT_TO_M2 = 0.09290304;
const AREA_RE = /(\d[\d\s.,'’]*)\s*(m²|m2|m\^2|sq\.?\s?m(?:eters?|etres?)?\b|sqm|qm\b|㎡|mq\b|متر|م²|م2|sq\.?\s?ft\.?|sqft|ft²|ft2|square\s?feet|sf\b|sq\.?\s?yd|yd²)/i;

/** Living area in m². Accepts "85,5 m²", "915 sq ft", or a number with unit ('m2' | 'sqft' | 'sqyd'). */
export function parseArea(input, unit = 'm2') {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return toM2(input, unit);
  const text = String(input).replace(/\u00a0/g, ' ');
  const m = text.match(AREA_RE);
  if (!m) {
    if (/^\s*[\d.,\s]+\s*$/.test(text)) return toM2(parseNumber(text), unit);
    return null;
  }
  const n = parseNumber(m[1].trim().replace(/[.,]$/, ''));
  const u = /ft|sf|feet/i.test(m[2]) ? 'sqft' : /yd/i.test(m[2]) ? 'sqyd' : 'm2';
  return toM2(n, u);
}

function toM2(n, unit) {
  if (!n || n <= 0) return null;
  const v = /ft/i.test(unit) ? n * SQFT_TO_M2 : /yd/i.test(unit) ? n * 0.83612736 : n;
  // Below 8 m² or above 100 000 m² is not a plausible home; treat as unknown.
  return v >= 8 && v <= 100000 ? Math.round(v * 10) / 10 : null;
}

export const m2ToSqft = (m2) => (m2 == null ? null : m2 / SQFT_TO_M2);

const ROOM_RE = /(\d+(?:[.,]5)?)\s*(?:\+\s*\d+\s*)?(rooms?|zimmer|zi\.?|pi[eè]ces?|pcs|p\b|habitaci[oó]n(?:es)?|hab\.?|dormitorios?|camere|vani|kamers?|pokoj|غرف(?:ة)?|غرفة|beds?|bedrooms?|bd|br\b|bhk|chambres?|ch\.?\b|slaapkamers?|r\b)/i;

/** Rooms / bedrooms as a number. "Studio" counts as 1. */
export function parseRooms(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return input >= 0 && input < 50 ? input : null;
  const text = String(input);
  if (/\bstudio\b|ستوديو|1-zimmer|einzimmer/i.test(text) && !ROOM_RE.test(text)) return 1;
  const m = text.match(ROOM_RE) || text.match(/^\s*(\d+(?:[.,]5)?)\s*$/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return n >= 0 && n < 50 ? n : null;
}

const TYPES = [
  ['land', /\b(plot|land|lot|grundst[uü]ck|baugrundst|terrain|terreno|solar|parcel|أرض|ارض)\b/i],
  ['commercial', /\b(office|retail|shop|commercial|warehouse|b[uü]ro|gewerbe|laden|bureaux?|local comercial|oficina|مكتب|محل|مستودع)\b/i],
  ['house', /\b(house|villa|townhouse|bungalow|detached|semi-detached|semi-d|terrace|single[- ]?family|multi[- ]?family|terraced|end-of-terrace|end of terrace|mews|cottage|farmhouse|haus|einfamilienhaus|reihenhaus|doppelhaush[aä]lfte|maison|casa|chalet|vivienda unifamiliar|فيلا|منزل|بيت)\b/i],
  ['apartment', /\b(apartment|appartment|flat|condo|condominium|studio|penthouse|loft|duplex|maisonette|wohnung|etagenwohnung|appartement|piso|apartamento|ático|atico|شقة|شقه|دوبلكس)\b/i],
];

export function detectType(text, fallback = 'apartment') {
  const t = String(text ?? '');
  for (const [type, re] of TYPES) if (re.test(t)) return type;
  return fallback;
}

const RENT_WORDS = /\b(for rent|to rent|to let|rental|zu vermieten|zur miete|mietwohnung|miete|à louer|a louer|location|en alquiler|alquiler|se alquila|in affitto|te huur|للإيجار|للايجار|ايجار)\b/i;
const SALE_WORDS = /\b(for sale|zu verkaufen|kaufen|kaufpreis|à vendre|a vendre|en venta|se vende|in vendita|te koop|للبيع)\b/i;

export function detectDealType(text, { period, fallback = 'sale' } = {}) {
  if (period) return 'rent';
  const t = String(text ?? '');
  if (SALE_WORDS.test(t)) return 'sale';
  if (RENT_WORDS.test(t)) return 'rent';
  return fallback;
}

/** Room band used to build comparable groups: 0-1, 2, 3, 4, 5+. */
export function roomsBand(rooms) {
  if (rooms == null) return null;
  if (rooms < 2) return '1';
  if (rooms >= 5) return '5+';
  return String(Math.floor(rooms));
}

/** Clean an absolute listing URL: drop tracking params and the #fragment. */
export function cleanUrl(href, base) {
  if (!href || typeof href !== 'string' || /^(null|undefined|#|javascript:)/i.test(href.trim())) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_|src$|source$|from$|tracking|trk|_ga|mc_|sid$|sessionid)/i.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export function formatMoney(n, currency = 'EUR') {
  if (n == null || !Number.isFinite(n)) return '?';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString('en-US')} ${currency}`;
  }
}

export function formatArea(m2, unit = 'm2') {
  if (m2 == null) return '?';
  return unit === 'sqft' ? `${Math.round(m2ToSqft(m2)).toLocaleString('en-US')} sq ft` : `${Math.round(m2)} m²`;
}

/** Price per m² (or per sq ft when unit = 'sqft') formatted for people. */
export function formatPerArea(perM2, currency, unit = 'm2') {
  if (perM2 == null) return '?';
  return unit === 'sqft' ? `${formatMoney(perM2 * SQFT_TO_M2, currency)}/sq ft` : `${formatMoney(perM2, currency)}/m²`;
}

/** "1 room", "3 rooms", "studio", "? rooms". */
export const roomsLabel = (n) => (n == null ? '? rooms' : n === 0 ? 'studio' : `${n} room${n === 1 ? '' : 's'}`);
