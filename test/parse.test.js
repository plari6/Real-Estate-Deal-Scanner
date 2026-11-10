import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, detectDealType, detectType, parseArea, parseNumber, parsePrice, parseRooms, roomsBand, roomsLabel, formatPerArea } from '../src/parse.js';
import { detectFlags } from '../src/flags.js';
import { guessDistrict, normalizeListing } from '../src/normalize.js';

test('parsePrice reads international price formats', () => {
  const cases = [
    ['€ 349.000', 349000, 'EUR'],
    ['349.000,- €', 349000, 'EUR'],
    ['EUR 349.000,50', 349000.5, 'EUR'],
    ['$1,250,000 3 beds', 1250000, 'USD'],
    ['1 299 000 €', 1299000, 'EUR'],
    ["CHF 1'299'000", 1299000, 'CHF'],
    ['AED 1.2M', 1200000, 'AED'],
    ['1,2 Mio. €', 1200000, 'EUR'],
    ['350k', 350000, 'EUR'],
    ['12.500.000 EGP', 12500000, 'EGP'],
    ['£ 1,500 pcm', 1500, 'GBP'],
    [425000, 425000, 'EUR'],
  ];
  for (const [input, amount, currency] of cases) {
    const p = parsePrice(input, { currency: 'EUR' });
    assert.equal(p.amount, amount, String(input));
    assert.equal(p.currency, currency, String(input));
  }
  assert.equal(parsePrice('$2,450/mo').period, 'month');
  assert.equal(parsePrice('£ 1,500 pcm').period, 'month');
  assert.equal(parsePrice('AED 120,000 yearly').period, 'year');
  assert.equal(parsePrice('€ 349.000').period, null);
  assert.equal(parsePrice('Price on request'), null);
  assert.equal(parsePrice('Preis auf Anfrage'), null);
  assert.equal(parsePrice(''), null);
});

test('parseNumber handles thousand and decimal separators', () => {
  assert.equal(parseNumber('1.299.000'), 1299000);
  assert.equal(parseNumber('1,299,000'), 1299000);
  assert.equal(parseNumber('85,5'), 85.5);
  assert.equal(parseNumber('1.2', { hasMultiplier: true }), 1.2);
  assert.equal(parseNumber('0.750'), 0.75);
});

test('parseArea converts units to m² and rejects implausible values', () => {
  assert.equal(parseArea('85,5 m²'), 85.5);
  assert.equal(parseArea('Wohnfläche 72 m2'), 72);
  assert.equal(parseArea('915 sq ft'), 85);
  assert.equal(parseArea('1,586 sq. ft.'), 147.3);
  assert.equal(parseArea('120 م²'), 120);
  assert.equal(parseArea(1000, 'sqft'), 92.9);
  assert.equal(parseArea('3'), null);
  assert.equal(parseArea('no area'), null);
});

test('parseRooms, types and deal type in several languages', () => {
  assert.equal(parseRooms('3 Zimmer'), 3);
  assert.equal(parseRooms('3.5 Zi.'), 3.5);
  assert.equal(parseRooms('2 bd'), 2);
  assert.equal(parseRooms('4 bedrooms'), 4);
  assert.equal(parseRooms('2 pièces'), 2);
  assert.equal(parseRooms('3 غرف'), 3);
  assert.equal(parseRooms('Studio'), 1);
  assert.equal(parseRooms('3 Bed'), 3);
  assert.equal(detectType('Schöne Wohnung'), 'apartment');
  assert.equal(detectType('Villa in Dubai Hills'), 'house');
  assert.equal(detectType('Semi-D'), 'house');
  assert.equal(detectType('Baugrundstück 600 m²'), 'land');
  assert.equal(detectType('nothing', null), null);
  assert.equal(detectDealType('Flat to rent in Kreuzberg'), 'rent');
  assert.equal(detectDealType('Apartment', { period: 'month' }), 'rent');
  assert.equal(detectDealType('Wohnung zu verkaufen'), 'sale');
  assert.equal(roomsBand(1), '1');
  assert.equal(roomsBand(3.5), '3');
  assert.equal(roomsBand(7), '5+');
  assert.equal(roomsLabel(1), '1 room');
  assert.equal(roomsLabel(0), 'studio');
});

test('cleanUrl makes links absolute and strips tracking', () => {
  assert.equal(cleanUrl('/listing/1?utm_source=x&id=5#top', 'https://portal.example/search'), 'https://portal.example/listing/1?id=5');
  assert.equal(cleanUrl('null', 'https://portal.example/'), null);
  assert.equal(cleanUrl(null, 'https://portal.example/'), null);
  assert.equal(cleanUrl('javascript:void(0)', 'https://portal.example/'), null);
});

test('formatPerArea shows per sq ft for sqft markets', () => {
  assert.equal(formatPerArea(10000, 'GBP', 'm2'), '£10,000/m²');
  assert.equal(formatPerArea(10000, 'GBP', 'sqft'), '£929/sq ft');
});

test('red flags: multilingual, with no false positives on normal listings', () => {
  const flags = (title, description) => detectFlags({ title, description, area_m2: 80 });
  assert.deepEqual(flags('Zwangsversteigerung: 3-Zimmer-Wohnung'), ['auction']);
  assert.deepEqual(flags('Foreclosure auction, minimum bid'), ['auction']);
  assert.deepEqual(flags('1/2 share of a house'), ['share']);
  assert.deepEqual(flags('Viager occupé à Paris'), ['share']);
  assert.deepEqual(flags('New project – prices from €250,000'), ['price_from']);
  assert.deepEqual(flags('Wohnung vermietet, ideale Kapitalanlage'), ['tenanted']);
  assert.deepEqual(flags('Fixer-upper with great bones'), ['renovation']);
  assert.deepEqual(flags('Appartement à rénover'), ['renovation']);
  assert.deepEqual(flags('Nice flat', 'Leasehold, 85 years remaining'), ['leasehold']);
  assert.deepEqual(flags('Off-plan, handover Q4 2027'), ['off_plan']);
  assert.deepEqual(flags('Appartement à louer'), []);
  assert.deepEqual(flags('Schöne Wohnung ab 2026 bezugsfrei'), []);
  assert.deepEqual(flags('Bright 3-bed flat, freshly renovated, rental potential'), []);
  assert.deepEqual(detectFlags({ title: 'Flat' }), ['no_area']);
});

test('guessDistrict picks the neighbourhood from an address', () => {
  assert.equal(guessDistrict('Oranienstraße 12, 10999 Berlin-Kreuzberg', 'Berlin'), 'Kreuzberg');
  assert.equal(guessDistrict('Marina Gate 1, Dubai Marina, Dubai', 'Dubai'), 'Dubai Marina');
  assert.equal(guessDistrict('Hurst Lane, London, SE2', 'London'), 'SE2');
  assert.equal(guessDistrict('34 Whitethorn Road, Clonskeagh, Dublin 14, D14CP58', 'Dublin'), 'Dublin 14');
  assert.equal(guessDistrict('The Old House, Dublin Road, Shankill, Co. Dublin, D18 Y6Y8', 'Dublin'), 'Shankill');
});

test('normalizeListing builds a complete record', () => {
  const source = { name: 'p', defaults: { city: 'Berlin', currency: 'EUR' } };
  const l = normalizeListing({ url: '/expose/77?utm_source=a', title: 'Helle Wohnung', price: '349.000 €', area: '82 m²', rooms: '3 Zimmer', address: 'Oranienstr. 1, Berlin-Kreuzberg', lat: '52.5', lng: '13.4' }, { source, pageUrl: 'https://portal.example/search' });
  assert.equal(l.url, 'https://portal.example/expose/77');
  assert.equal(l.uid, 'p:portal.example/expose/77');
  assert.equal(l.price, 349000);
  assert.equal(l.area_m2, 82);
  assert.equal(l.price_m2, 4256.1);
  assert.equal(l.rooms, 3);
  assert.equal(l.district, 'Kreuzberg');
  assert.equal(l.city, 'Berlin');
  assert.equal(l.property_type, 'apartment');
  assert.equal(l.deal_type, 'sale');
  assert.equal(l.lat, 52.5);
  assert.ok(l.fingerprint);
  // The portal's type field wins over a misleading title; yearly rent becomes monthly.
  const flat = normalizeListing({ url: '/x', title: 'Flat in Salisbury House', type: 'Apartment', price: 300000 }, { source, pageUrl: 'https://p.example/' });
  assert.equal(flat.property_type, 'apartment');
  const rent = normalizeListing({ url: '/r', title: 'Flat to rent', price: 'AED 120,000 yearly' }, { source, pageUrl: 'https://p.example/' });
  assert.equal(rent.deal_type, 'rent');
  assert.equal(rent.price, 10000);
  assert.equal(normalizeListing({ url: '/n', price: 'on request' }, { source, pageUrl: 'https://p.example/' }), null);
  assert.equal(normalizeListing({ price: 100000 }, { source, pageUrl: 'https://p.example/' }), null);
});
