import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractListings } from '../src/adapters/index.js';
import { extractJsonLd } from '../src/adapters/jsonld.js';
import { extractEmbedded, findListingArrays, geoOf } from '../src/adapters/embedded.js';
import { extractCards } from '../src/adapters/css.js';
import { extractWithAI } from '../src/adapters/ai.js';

const PAGE = 'https://portal.example/search?page=1';
const page = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const src = (extra = {}) => ({ name: 't', defaults: { city: 'Berlin', currency: 'EUR' }, ...extra });

test('JSON-LD ItemList of Offers with Apartment, geo and rent unit', () => {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [{
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'ListItem', item: { '@type': 'Offer', url: '/l/1', price: 349000, priceCurrency: 'EUR', itemOffered: { '@type': 'Apartment', name: 'Flat A', floorSize: { value: 82, unitCode: 'MTK' }, numberOfRooms: 3, address: { addressLocality: 'Berlin', addressNeighborhood: 'Mitte' }, geo: { latitude: 52.52, longitude: 13.4 } } } },
        { '@type': 'ListItem', item: { '@type': 'Offer', url: '/l/2', price: 1450, priceCurrency: 'EUR', priceSpecification: { price: 1450, unitText: 'per month' }, itemOffered: { '@type': 'Apartment', name: 'Flat B', floorSize: { value: 950, unitCode: 'FTK' } } } },
      ],
    }],
  };
  const $ = cheerio.load(page('', `<script type="application/ld+json">${JSON.stringify(ld)}</script>`));
  const raw = extractJsonLd($, PAGE);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].area, 82);
  assert.equal(raw[0].district, 'Mitte');
  assert.equal(raw[0].lat, 52.52);
  assert.equal(raw[1].areaUnit, 'sqft');
  assert.match(raw[1].priceText, /per month/);
});

test('embedded JSON: finds the listing array, unwraps { listing }, ignores seller data, reads GeoJSON', async () => {
  const data = {
    props: { pageProps: { listings: [1, 2, 3].map((i) => ({
      listing: {
        id: i,
        title: `${i} Main Street, Clonskeagh, Dublin 14`,
        price: `€${400 + i},000`,
        numBedrooms: '3 Bed',
        propertyType: 'Semi-D',
        category: 'Buy',
        floorArea: { unit: 'METRES_SQUARED', value: 100 + i },
        seoFriendlyPath: `/for-sale/${i}-main-street/${i}`,
        point: { type: 'Point', coordinates: [-6.24, 53.31] },
        seller: { name: 'Agent', address: 'Agency Office, Dublin 2', phone: '01 234' },
      },
    })) } },
  };
  const html = page('<div id="__next"></div>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
  const { listings, method } = await extractListings(html, 'https://www.daft.example/property-for-sale/dublin', src({ defaults: { city: 'Dublin', currency: 'EUR' } }));
  assert.equal(method, 'embedded');
  assert.equal(listings.length, 3);
  const l = listings[0];
  assert.equal(l.url, 'https://www.daft.example/for-sale/1-main-street/1');
  assert.equal(l.price, 401000);
  assert.equal(l.area_m2, 101);
  assert.equal(l.rooms, 3);
  assert.equal(l.property_type, 'house');
  assert.equal(l.district, 'Dublin 14'); // from the property address, not the agent's
  assert.equal(l.lat, 53.31);
  assert.equal(l.lng, -6.24);
});

test('embedded JSON: Rightmove-like shape (no title, propertyUrl, nested price, sq ft size)', async () => {
  const props = [1, 2, 3].map((i) => ({
    id: 9000 + i,
    bedrooms: 2,
    displayAddress: `Hurst Lane, London, SE${i}`,
    propertySubType: 'Flat',
    propertyTypeFullDescription: '2 bedroom flat for sale',
    price: { amount: 300000 + i, currencyCode: 'GBP', displayPrices: [{ displayPrice: '£300,000' }] },
    displaySize: '700 sq. ft.',
    location: { latitude: 51.49, longitude: 0.11 },
    propertyUrl: `/properties/${9000 + i}#/?channel=RES_BUY`,
    transactionType: 'buy',
    customer: { branchDisplayName: 'Some Estate Agents, Chelsea', contactTelephone: '020' },
  }));
  const html = page('', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { searchResults: { properties: props } } } })}</script>`);
  const { listings } = await extractListings(html, 'https://www.rightmove.example/find.html', src({ defaults: { city: 'London', currency: 'GBP' } }));
  assert.equal(listings.length, 3);
  assert.equal(listings[0].title, '2 bedroom flat for sale – Hurst Lane, London, SE1');
  assert.equal(listings[0].url, 'https://www.rightmove.example/properties/9001');
  assert.equal(listings[0].currency, 'GBP');
  assert.equal(listings[0].area_m2, 65);
  assert.equal(listings[0].district, 'SE1');
  assert.equal(listings[0].deal_type, 'sale');
});

test('embedded JSON: fieldMap pins paths, urlTemplate builds links from ids', async () => {
  const data = { results: { hits: [{ ref: 'A1', cost: { v: 500000 }, sz: 100 }, { ref: 'A2', cost: { v: 600000 }, sz: 120 }] } };
  const html = page('', `<script type="application/json">${JSON.stringify(data)}</script>`);
  const source = src({ adapter: 'embedded', fieldMap: { list: 'results.hits', id: 'ref', price: 'cost.v', area: 'sz' }, urlTemplate: 'https://portal.example/property/{id}' });
  const { listings } = await extractListings(html, PAGE, source);
  assert.equal(listings.length, 2);
  assert.equal(listings[1].url, 'https://portal.example/property/A2');
  assert.equal(listings[1].price_m2, 5000);
});

test('geoOf reads lat/lng, latitude/longitude and GeoJSON', () => {
  assert.deepEqual(geoOf({ a: { lat: 1, lng: 2 } }), { lat: 1, lng: 2 });
  assert.deepEqual(geoOf({ point: { type: 'Point', coordinates: [13.4, 52.5] } }), { lat: 52.5, lng: 13.4 });
  assert.equal(geoOf({ seller: { lat: 1, lng: 2 } }), null);
});

test('findListingArrays ignores arrays that are not listings', () => {
  const blob = { nav: [{ label: 'Home', href: '/' }, { label: 'Buy', href: '/buy' }], items: [{ id: 1, price: 100000, size: 50, url: '/a' }, { id: 2, price: 120000, size: 60, url: '/b' }] };
  const found = findListingArrays(blob);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'items');
});

const CARDS = page(`
  <div class="results">
    ${[1, 2, 3, 4].map((i) => `
    <div class="property-card" data-lat="52.5" data-lng="13.4">
      <a href="/expose/${i}?ref=list"><img data-src="/img/${i}.jpg"></a>
      <h3 class="title">Wohnung ${i} in Neukölln</h3>
      <span class="price">${300 + i}.000 €</span>
      <ul><li>${70 + i} m²</li><li>3 Zimmer</li></ul>
      <p class="location">Sonnenallee ${i}, Berlin-Neukölln</p>
    </div>`).join('')}
    <div class="banner"><a href="/finance">Finance from 1.000 €</a></div>
  </div>`);

test('CSS selectors from sources.json', async () => {
  const source = src({ selectors: { card: '.property-card', title: '.title', price: '.price', area: 'li:nth-child(1)', rooms: 'li:nth-child(2)', location: '.location', link: 'a@href', image: 'img@data-src' } });
  const { listings, method } = await extractListings(CARDS, PAGE, source);
  assert.equal(method, 'css');
  assert.equal(listings.length, 4);
  assert.equal(listings[0].url, 'https://portal.example/expose/1');
  assert.equal(listings[0].price, 301000);
  assert.equal(listings[0].area_m2, 71);
  assert.equal(listings[0].district, 'Neukölln');
  assert.equal(listings[0].image, 'https://portal.example/img/1.jpg');
  assert.equal(listings[0].lat, 52.5);
});

test('heuristic card finder works with no configuration', async () => {
  const $ = cheerio.load(CARDS);
  const raw = extractCards($, PAGE);
  assert.equal(raw.length, 4);
  const { listings, method } = await extractListings(CARDS, PAGE, src());
  assert.equal(method, 'cards');
  assert.equal(listings.length, 4);
  assert.equal(listings[2].title, 'Wohnung 3 in Neukölln');
  assert.equal(listings[2].area_m2, 73);
  assert.equal(listings[2].rooms, 3);
});

test('AI adapter: used only when nothing else works, hallucinations are dropped', async () => {
  const html = page(`<p>Our offers</p><p>Penthouse with view – 890.000 € – 120 m² <a href="/o/1">details</a></p><p>Garden flat 450.000 € 80 m² <a href="/o/2">details</a></p>${'<p>filler text for the page</p>'.repeat(10)}`);
  const ai = {
    generate: async ({ parse }) => ({
      target: 'fake:model',
      data: parse(JSON.stringify({ listings: [
        { url: 'https://portal.example/o/1', title: 'Penthouse with view', price: '890.000 €', area: '120 m²', rooms: null, location: 'Berlin' },
        { url: 'https://portal.example/o/2', title: 'Garden flat', price: '450.000 €', area: '80 m²' },
        { url: 'https://portal.example/o/3', title: 'Invented villa', price: '999.000 €', area: '300 m²' }, // link not on page
        { url: 'https://portal.example/o/2', title: 'Wrong price', price: '123.456 €' }, // price not on page
      ] })),
    }),
  };
  const { listings, method, tried } = await extractListings(html, PAGE, src(), { ai });
  assert.equal(method, 'ai');
  assert.deepEqual(listings.map((l) => l.title), ['Penthouse with view', 'Garden flat']);
  assert.ok(tried.some((t) => t.adapter === 'ai'));
  // No AI configured, or AI down: no crash, no listings.
  assert.equal((await extractListings(html, PAGE, src())).listings.length, 0);
  const $ = cheerio.load(html);
  assert.deepEqual(await extractWithAI($, PAGE, { generate: async () => { throw new Error('all models down'); } }), []);
});

test('embedded JSON: attribute lists ({ key, value }) and "DH" currency (Avito-style classifieds)', async () => {
  const ads = [1, 2, 3].map((i) => ({
    listId: 5000 + i,
    subject: `Appartement à vendre ${100 + i} m² à Casablanca`,
    price: { value: 1500000 + i, currency: 'DH' },
    params: { secondary: [{ key: 'rooms', label: 'Chambres', value: '3' }, { key: 'size', label: 'Surface totale', value: 100 + i, unit: 'm²' }, { key: 'floor', value: '2' }] },
    location: 'Casablanca, Maarif',
    href: `https://www.avito.example/fr/maarif/appartements/x_${i}.htm`,
    seller: { name: 'Agence', phone: '06' },
  }));
  const html = page('', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ads: { ads } } } })}</script>`);
  const { listings } = await extractListings(html, 'https://www.avito.example/fr/casablanca', src({ defaults: { city: 'Casablanca', currency: 'MAD' } }));
  assert.equal(listings.length, 3);
  assert.equal(listings[0].currency, 'MAD');
  assert.equal(listings[0].area_m2, 101);
  assert.equal(listings[0].rooms, 3);
  assert.equal(listings[0].district, 'Maarif');
});

test('card finder recognises dirham prices and takes the district from the title', async () => {
  const html = page([1, 2, 3].map((i) => `<div class="listingBox"><a href="/fr/pa/${i}/x"><h2>Appartement de ${60 + i}m² à vendre à Riviera</h2></a><span class="priceTag">1 ${700 + i} 000 DH</span><p>3 Pièces 2 Chambres</p></div>`).join(''));
  const { listings, method } = await extractListings(html, 'https://www.mubawab.example/fr/st/casablanca', src({ defaults: { city: 'Casablanca', currency: 'MAD' } }));
  assert.equal(method, 'cards');
  assert.equal(listings.length, 3);
  assert.equal(listings[0].price, 1701000);
  assert.equal(listings[0].currency, 'MAD');
  assert.equal(listings[0].area_m2, 61);
  assert.equal(listings[0].district, 'Riviera');
});
