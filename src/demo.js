// Offline demo: three fake portals on localhost, each in a different page format
//   /a  "HomeFinder"   schema.org JSON-LD ItemList        (adapter: jsonld)
//   /b  "Nestly"       Next.js __NEXT_DATA__ app state     (adapter: embedded)
//   /c  "ClassicImmo"  plain HTML cards, CSS selectors     (adapter: css)
// with pagination, detail pages, planted bargains and traps (auction, "price from", data error,
// renovation) and a second day where prices drop.
import http from 'node:http';

const DISTRICTS = { Mitte: 7400, Kreuzberg: 6500, 'Prenzlauer Berg': 7000, Neukölln: 5200, Charlottenburg: 6900, Friedrichshain: 6300 };
// District centres (lat, lng); listings are scattered about 600 m around them.
const CENTRES = { Mitte: [52.52, 13.405], Kreuzberg: [52.4986, 13.403], 'Prenzlauer Berg': [52.539, 13.424], Neukölln: [52.4811, 13.435], Charlottenburg: [52.516, 13.304], Friedrichshain: [52.515, 13.454] };
const STREETS = ['Linienstraße', 'Oranienstraße', 'Kastanienallee', 'Sonnenallee', 'Kantstraße', 'Boxhagener Straße', 'Torstraße', 'Wiener Straße', 'Pappelallee', 'Weserstraße'];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The demo market: ~100 normal listings + planted ones, spread over 3 portals x 3 pages. */
export function demoListings(day = 1) {
  const r = rng(42);
  const names = Object.keys(DISTRICTS);
  const out = [];
  let n = 0;
  const geo = (district) => ({ lat: +(CENTRES[district][0] + (r() - 0.5) * 0.012).toFixed(6), lng: +(CENTRES[district][1] + (r() - 0.5) * 0.018).toFixed(6) });
  for (const portal of ['a', 'b', 'c']) {
    for (let i = 0; i < 33; i++) {
      const district = names[Math.floor(r() * names.length)];
      const rooms = 1 + Math.floor(r() * 4);
      const area = Math.round(28 + rooms * 21 + (r() - 0.5) * 18);
      const ppm2 = DISTRICTS[district] * (0.88 + r() * 0.24);
      out.push({
        id: `${portal}${1000 + n++}`,
        portal,
        district,
        rooms,
        area,
        price: Math.round((area * ppm2) / 1000) * 1000,
        title: `${rooms === 1 ? 'Cosy 1-room flat' : `Bright ${rooms}-room apartment`} in ${district}`,
        street: `${STREETS[Math.floor(r() * STREETS.length)]} ${1 + Math.floor(r() * 120)}`,
        description: 'Well kept apartment with balcony, parquet floors and a fitted kitchen. Close to public transport.',
        ...geo(district),
      });
    }
  }
  const plant = (portal, o) => out.push({ id: `${portal}${1000 + n++}`, portal, street: 'Musterstraße 1', description: 'Well kept apartment, available immediately.', ...geo(o.district), ...o });
  // Genuine bargains (inheritance sale, quick sale, private seller).
  plant('a', { district: 'Kreuzberg', rooms: 3, area: 82, price: 359000, title: 'Inheritance sale: 3-room apartment with balcony in Kreuzberg', description: 'Sold by heirs, quick completion wanted. Good condition, 2nd floor, balcony facing the courtyard.' });
  plant('b', { district: 'Prenzlauer Berg', rooms: 2, area: 61, price: 309000, title: '2-room apartment, private seller, Prenzlauer Berg', description: 'Private sale without agent. Renovated 2021, quiet side street.' });
  plant('c', { district: 'Mitte', rooms: 2, area: 58, price: 299000, title: 'Quick sale! 2-room flat near Rosenthaler Platz', description: 'Owner relocating abroad, priced for a fast sale. Lift, cellar.' });
  // Discounted for a reason: renovation (still alerted, flagged).
  plant('a', { district: 'Charlottenburg', rooms: 4, area: 118, price: 549000, title: '4-room Altbau apartment in need of renovation', description: 'Needs renovation: old heating and bathrooms. High ceilings, great potential.' });
  // Traps that must not be alerted.
  plant('b', { district: 'Neukölln', rooms: 2, area: 64, price: 179000, title: 'Auction: 2-room apartment in Neukölln', description: 'Foreclosure auction at the district court. Minimum bid shown.' });
  plant('c', { district: 'Friedrichshain', rooms: 3, area: 79, price: 99000, title: '3-room apartment in Friedrichshain', description: 'Bright flat with balcony.' }); // data error (79 % below)
  plant('a', { district: 'Mitte', rooms: 1, area: 41, price: 189000, title: 'New build project Mitte – prices from €189,000', description: 'Prices from 189.000 € for the smallest unit.' });
  // Rent listing on a sale portal: must be compared with rents only.
  plant('b', { district: 'Kreuzberg', rooms: 2, area: 55, price: 1450, rent: true, title: '2-room flat to rent in Kreuzberg', description: 'Monthly rent, available from March.' });
  // The same flat on two portals (cross-portal duplicate): counted once in the market average.
  const dup = out.find((l) => l.portal === 'a' && l.district === 'Mitte');
  out.push({ ...dup, id: `b${dup.id.slice(1)}d`, portal: 'b' });

  if (day >= 2) {
    // Day 2: a fair Friedrichshain flat is cut 25 % (new deal), and the Kreuzberg bargain drops again.
    const fair = out.find((l) => l.portal === 'b' && l.district === 'Friedrichshain' && !l.rent);
    fair.price = Math.round((fair.price * 0.72) / 1000) * 1000;
    fair.title = `Price reduced: ${fair.title}`;
    const k = out.find((l) => l.title.startsWith('Inheritance sale'));
    k.price = 339000;
  }
  return out;
}

const PER_PAGE = 13;
const pageOf = (list, portal, page) => list.filter((l) => l.portal === portal).slice((page - 1) * PER_PAGE, page * PER_PAGE);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmtEur = (n) => `${Math.round(n).toLocaleString('de-DE')} €`;

function shell(title, body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}

function portalA(base, items, page) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((l, i) => ({
      '@type': 'ListItem',
      position: (page - 1) * PER_PAGE + i + 1,
      item: {
        '@type': 'Offer',
        url: `${base}/listing/${l.id}?utm_source=search`,
        name: l.title,
        price: l.price,
        priceCurrency: 'EUR',
        ...(l.rent ? { priceSpecification: { '@type': 'UnitPriceSpecification', price: l.price, priceCurrency: 'EUR', unitText: 'per month' } } : {}),
        itemOffered: {
          '@type': 'Apartment',
          name: l.title,
          floorSize: { '@type': 'QuantitativeValue', value: l.area, unitCode: 'MTK' },
          numberOfRooms: l.rooms,
          address: { '@type': 'PostalAddress', streetAddress: l.street, addressLocality: 'Berlin', addressNeighborhood: l.district },
          geo: { '@type': 'GeoCoordinates', latitude: l.lat, longitude: l.lng },
        },
        image: `${base}/img/${l.id}.jpg`,
      },
    })),
  };
  const cards = items.map((l) => `<div class="card"><a href="/listing/${l.id}">${esc(l.title)}</a></div>`).join('');
  return shell('HomeFinder – apartments in Berlin', `<h1>Apartments for sale in Berlin</h1>${cards}`, `<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
}

function portalB(base, items) {
  const data = {
    props: {
      pageProps: {
        search: {
          total: 99,
          results: items.map((l) => ({
            listingId: l.id,
            title: l.title,
            price: { amount: l.price, currency: 'EUR', period: l.rent ? 'monthly' : null },
            priceFormatted: l.rent ? `${fmtEur(l.price)} / month` : fmtEur(l.price),
            livingArea: l.area,
            rooms: l.rooms,
            location: { city: 'Berlin', district: l.district, street: l.street, coordinates: { lat: l.lat, lng: l.lng } },
            propertyType: 'apartment',
            dealType: l.rent ? 'rent' : 'sale',
            detailUrl: `/listing/${l.id}`,
            images: [{ url: `${base}/img/${l.id}.jpg` }],
          })),
        },
      },
    },
  };
  // The HTML itself is an empty shell, like a client-rendered Next.js page.
  return shell('Nestly – Berlin', '<div id="__next">Loading…</div>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`);
}

function portalC(base, items) {
  const cards = items.map((l) => `
    <article class="result" data-lat="${l.lat}" data-lng="${l.lng}">
      <a class="result-link" href="/listing/${l.id}?ref=list"><img data-src="/img/${l.id}.jpg" alt=""></a>
      <h2 class="result-title">${esc(l.title)}</h2>
      <div class="result-price">${l.rent ? `${fmtEur(l.price)} / Monat` : fmtEur(l.price)}</div>
      <ul class="facts"><li class="area">${String(l.area).replace('.', ',')} m²</li><li class="rooms">${l.rooms} Zimmer</li></ul>
      <p class="result-address">${esc(l.street)}, Berlin-${esc(l.district)}</p>
    </article>`).join('');
  return shell('ClassicImmo – Wohnungen Berlin', `<main><h1>Wohnungen kaufen Berlin</h1>${cards}<nav class="pager"><a href="?">next</a></nav></main>`);
}

function detail(l) {
  const ld = { '@context': 'https://schema.org', '@type': 'Apartment', name: l.title, description: l.description, floorSize: { '@type': 'QuantitativeValue', value: l.area, unitCode: 'MTK' } };
  return shell(l.title, `<h1>${esc(l.title)}</h1><div class="description">${esc(l.description)}</div>`, `<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
}

/** Start the fake portals. Returns { base, setDay(n), close() }. */
export async function startDemoPortals({ port = 0 } = {}) {
  let day = 1;
  let list = demoListings(day);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const base = `http://${req.headers.host}`;
    const send = (status, body, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    if (u.pathname === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private/\n', 'text/plain');
    if (u.pathname.startsWith('/img/')) return send(200, 'GIF89a', 'image/gif');
    let m = u.pathname.match(/^\/listing\/(\w+)$/);
    if (m) {
      const l = list.find((x) => x.id === m[1]);
      return l ? send(200, detail(l)) : send(404, shell('Not found', 'Listing removed'));
    }
    if (u.pathname === '/a/search') return send(200, portalA(base, pageOf(list, 'a', Number(u.searchParams.get('page') || 1)), Number(u.searchParams.get('page') || 1)));
    if (u.pathname === '/b/search') return send(200, portalB(base, pageOf(list, 'b', Number(u.searchParams.get('p') || 1))));
    m = u.pathname.match(/^\/c\/search\/(\d+)$/);
    if (m) return send(200, portalC(base, pageOf(list, 'c', Number(m[1]))));
    if (u.pathname === '/blocked') return send(403, shell('Access denied', 'Please verify you are a human (captcha)'));
    return send(404, shell('Not found', 'Not found'));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    setDay(d) { day = d; list = demoListings(day); },
    get day() { return day; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** Sources pointing at the fake portals (same format as sources.json). */
export function demoSources(base) {
  const defaults = { city: 'Berlin', currency: 'EUR', type: 'apartment', dealType: 'sale' };
  return [
    { name: 'homefinder', url: `${base}/a/search?page={page}`, pages: 3, engine: 'auto', adapter: 'auto', defaults },
    { name: 'nestly', url: `${base}/b/search`, pageParam: 'p', pages: 3, engine: 'auto', adapter: 'auto', defaults },
    {
      name: 'classic-immo',
      url: `${base}/c/search/{page}`,
      pages: 3,
      engine: 'auto',
      adapter: 'auto',
      defaults,
      selectors: { card: 'article.result', title: '.result-title', price: '.result-price', area: '.facts .area', rooms: '.facts .rooms', location: '.result-address', link: 'a.result-link@href', image: 'img@data-src' },
    },
  ];
}
