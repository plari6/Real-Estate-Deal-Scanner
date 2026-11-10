// Red flags: reasons a listing can look 20 % cheap without being a real bargain.
// Multilingual keyword rules (EN / DE / FR / ES / IT / NL / AR). The AI review can add more.
import { normText } from './parse.js';

export const FLAGS = {
  auction: {
    label: 'Auction / foreclosure',
    hint: 'Price shown is the starting bid, the final price is usually higher.',
    re: /\b(auction|foreclos\w*|bank owned|reo\b|short sale|sheriff sale|zwangsversteigerung|versteigerung|teilungsversteigerung|mindestgebot|encheres?\b|vente judiciaire|subasta|asta giudiziaria|veiling|مزاد)/,
  },
  share: {
    label: 'Partial share only',
    hint: 'Only a share of the property is for sale (co-ownership, fraction, bare ownership).',
    re: /(\b\d\s?\/\s?\d\s?(share|anteil|part)\b|\bfractional\b|co-?ownership share|\btimeshare|miteigentumsanteil|nue-?propriete|\bviager\b|nuda propiedad|multipropiedad|نصيب|حصة)/,
  },
  price_from: {
    label: '"Price from" (project)',
    hint: 'A starting price for a project or several units, not this unit\'s price.',
    re: /\b(prices? from|starting (at|from)|from only|preise ab|ab \d[\d.,]*\s?(€|eur)|a partir de \d|desde \d[\d.,]*\s?(€|eur)|ابتداء من|يبدأ من)/,
  },
  rent_to_own: {
    label: 'Rent-to-own / lease',
    hint: 'Deposit or first instalment, not the full purchase price.',
    re: /\b(rent to own|lease to own|deposit only|mietkauf|location-accession|alquiler con opcion|ايجار منتهي بالتمليك)/,
  },
  tenanted: {
    label: 'Tenanted',
    hint: 'Sold with a sitting tenant: cheaper, but you cannot move in.',
    re: /\b(tenanted|sitting tenant|tenant in place|currently (let|rented|occupied)|vermietet\b|vendu loue\b|loue a\b|alquilad[oa]\b|con inquilino|affittato\b|verhuurd\b|مؤجر)/,
  },
  renovation: {
    label: 'Needs renovation',
    hint: 'Discount may be eaten by works; can also be a flip opportunity.',
    re: /\b(needs? (renovation|work|updating|tlc)|fixer[- ]upper|handyman special|sold as[- ]is|renovierungsbedurftig|sanierungsbedurftig|modernisierungsbedurftig|a renover|travaux a prevoir|a reformar|para reformar|da ristrutturare|opknapper|يحتاج (الى )?تشطيب|بدون تشطيب)/,
  },
  leasehold: {
    label: 'Leasehold / ground lease',
    hint: 'Land is leased; short remaining terms lower the value.',
    re: /\b(leasehold|ground lease|ground rent|erbpacht|erbbaurecht|bail emphyteotique|derecho de superficie)/,
  },
  off_plan: {
    label: 'Off-plan / under construction',
    hint: 'Not built yet: delivery and developer risk.',
    re: /\b(off[- ]plan|under construction|pre-?construction|handover (in|q\d)|im bau\b|en construction|sur plan\b|en construccion|sobre plano|قيد الانشاء|على الخارطة)/,
  },
  no_area: {
    label: 'No living area',
    hint: 'Compared by price only, less precise than price per m².',
    re: null,
  },
};

/** Keyword flags found in the listing's own text (title, description, price label). */
export function detectFlags(listing) {
  const text = normText([listing.title, listing.description, listing.priceText].filter(Boolean).join(' \n '));
  const out = new Set(listing.flags || []);
  for (const [key, f] of Object.entries(FLAGS)) if (f.re && f.re.test(text)) out.add(key);
  if (!listing.area_m2) out.add('no_area');
  return [...out];
}

export const flagLabel = (key) => FLAGS[key]?.label || String(key).replace(/_/g, ' ');
