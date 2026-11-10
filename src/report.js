// Reports: Excel (Deals / To check / All listings / Market, clickable links), CSV (; + BOM for Excel),
// JSON, and a self-contained HTML page for clients.
import fs from 'node:fs';
import path from 'node:path';
import { marketSummary } from './market.js';
import { flagLabel } from './flags.js';
import { formatArea, formatMoney, formatPerArea, m2ToSqft, roomsLabel } from './parse.js';

const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);
const flagsText = (l) => (l.flags || []).filter((f) => f !== 'no_area').map(flagLabel).join(', ');

function rowsFor(listings, unit) {
  return listings.map((l) => ({
    score: l.score ?? null,
    status: l.deal_status,
    discount: pct(l.discount),
    title: l.title,
    price: l.price,
    currency: l.currency,
    estimated_value: l.estimated_value,
    below_market: l.savings,
    price_per_area: l.price_m2 == null ? null : Math.round(unit === 'sqft' ? l.price_m2 / m2ToSqft(1) : l.price_m2),
    market_per_area: l.metric === 'm2' && l.market ? Math.round(unit === 'sqft' ? l.market / m2ToSqft(1) : l.market) : null,
    area: l.area_m2 == null ? null : Math.round(unit === 'sqft' ? m2ToSqft(l.area_m2) : l.area_m2),
    rooms: l.rooms,
    type: l.property_type,
    deal_type: l.deal_type,
    district: l.district,
    city: l.city,
    segment: l.segment,
    comps: l.comps,
    confidence: pct(l.confidence),
    flags: flagsText(l),
    review: l.ai_review?.summary || (l.reasons || []).join('; ') || null,
    verdict: l.ai_review?.verdict || null,
    source: l.source,
    first_seen: l.first_seen?.slice(0, 10),
    last_seen: l.last_seen?.slice(0, 10),
    url: l.url,
  }));
}

const COLS = (unit) => [
  ['Score', 'score', 8], ['Below market %', 'discount', 10], ['Title', 'title', 44], ['Price', 'price', 13, '#,##0'],
  ['Est. value', 'estimated_value', 13, '#,##0'], ['Below by', 'below_market', 12, '#,##0'], ['Cur.', 'currency', 6],
  [unit === 'sqft' ? 'Price/sq ft' : 'Price/m²', 'price_per_area', 11, '#,##0'], [unit === 'sqft' ? 'Market/sq ft' : 'Market/m²', 'market_per_area', 11, '#,##0'],
  [unit === 'sqft' ? 'Sq ft' : 'm²', 'area', 8], ['Rooms', 'rooms', 7], ['District', 'district', 18], ['City', 'city', 12], ['Type', 'type', 11],
  ['Compared with', 'segment', 30], ['Comps', 'comps', 7], ['Confidence %', 'confidence', 10], ['Flags', 'flags', 24],
  ['Review', 'review', 50], ['Verdict', 'verdict', 9], ['Source', 'source', 14], ['First seen', 'first_seen', 11], ['Status', 'status', 10],
];

async function writeXlsx(file, { deals, review, all, market, unit }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Real-Estate Deal Scanner';
  const sheet = (name, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = COLS(unit);
    ws.columns = [...cols.map(([header, key, width, fmt]) => ({ header, key, width, style: fmt ? { numFmt: fmt } : {} })), { header: 'Link', key: 'link', width: 14 }];
    for (const r of rows) {
      const row = ws.addRow({ ...r, link: r.url ? { text: 'Open listing', hyperlink: r.url } : null });
      row.getCell('link').font = { color: { argb: 'FF0563C1' }, underline: true };
      if (r.status === 'deal' && r.score >= 75) row.getCell('score').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    }
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length + 1 } };
  };
  sheet('Deals', deals);
  sheet('To check', review);
  sheet('All listings', all);
  const ms = wb.addWorksheet('Market', { views: [{ state: 'frozen', ySplit: 1 }] });
  ms.columns = [
    { header: 'City', key: 'city', width: 14 }, { header: 'District', key: 'district', width: 20 }, { header: 'Type', key: 'property_type', width: 12 },
    { header: 'Sale/Rent', key: 'deal_type', width: 9 }, { header: 'Listings', key: 'n', width: 9 },
    { header: `Median /${unit === 'sqft' ? 'sq ft' : 'm²'}`, key: 'median', width: 13, style: { numFmt: '#,##0' } },
    { header: 'P25', key: 'p25', width: 11, style: { numFmt: '#,##0' } }, { header: 'P75', key: 'p75', width: 11, style: { numFmt: '#,##0' } },
    { header: 'Min', key: 'min', width: 11, style: { numFmt: '#,##0' } }, { header: 'Max', key: 'max', width: 11, style: { numFmt: '#,##0' } },
    { header: 'Currency', key: 'currency', width: 9 },
  ];
  const k = unit === 'sqft' ? 1 / m2ToSqft(1) : 1;
  for (const g of market) ms.addRow({ ...g, median: g.median * k, p25: g.p25 * k, p75: g.p75 * k, min: g.min * k, max: g.max * k });
  ms.getRow(1).font = { bold: true };
  ms.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 11 } };
  await wb.xlsx.writeFile(file);
}

function toCsv(rows) {
  const cols = COLS('m2').map(([h, k]) => [h, k]).concat([['Link', 'url']]);
  const cell = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\ufeff${cols.map(([h]) => cell(h)).join(';')}\n${rows.map((r) => cols.map(([, k]) => cell(r[k])).join(';')).join('\n')}\n`;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toHtml(deals, market, { unit, generatedAt }) {
  const cards = deals.map((l) => `
  <article class="deal">
    ${l.image ? `<img src="${esc(l.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <div class="body">
      <div class="top"><span class="pct">${Math.round((l.discount || 0) * 100)}% below</span><span class="score">score ${l.score}</span></div>
      <h3><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title || 'Listing')}</a></h3>
      <p class="facts">${esc(formatMoney(l.price, l.currency))} · ${esc(formatArea(l.area_m2, unit))} · ${roomsLabel(l.rooms)} · ${esc([l.district, l.city].filter(Boolean).join(', '))}</p>
      <p>${l.metric === 'm2' ? `${esc(formatPerArea(l.price_m2, l.currency, unit))} vs ${esc(formatPerArea(l.market, l.currency, unit))}` : ''} · est. value ${esc(formatMoney(l.estimated_value, l.currency))} (<b>${esc(formatMoney(l.savings, l.currency))}</b> below)</p>
      <p class="muted">${esc(l.segment)} · ${l.comps} comps · ${esc(l.source)}</p>
      ${flagsText(l) ? `<p class="flags">⚠ ${esc(flagsText(l))}</p>` : ''}
      ${l.ai_review?.summary ? `<p class="review">${esc(l.ai_review.summary)}</p>` : ''}
    </div>
  </article>`).join('');
  const k = unit === 'sqft' ? 1 / m2ToSqft(1) : 1;
  const rows = market.filter((g) => g.deal_type === 'sale').map((g) => `<tr><td>${esc(g.city)}</td><td>${esc(g.district)}</td><td>${esc(g.property_type)}</td><td>${g.n}</td><td>${esc(formatMoney(g.median * k, g.currency))}</td><td>${esc(formatMoney(g.p25 * k, g.currency))} – ${esc(formatMoney(g.p75 * k, g.currency))}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Property Deals Report</title><style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#667085;--accent:#0b7a4b;--warn:#a15c00;--line:#e4e7ec}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f25;--text:#e8eaed;--muted:#98a2b3;--accent:#4ade80;--warn:#fbbf24;--line:#2a313a}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin:20px 0 36px}
.deal{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}.deal img{width:100%;height:170px;object-fit:cover;display:block}
.body{padding:14px 16px}.top{display:flex;justify-content:space-between}.pct{color:var(--accent);font-weight:700;font-size:18px}.score{color:var(--muted)}
h3{margin:6px 0;font-size:16px}a{color:inherit}.facts{font-weight:600}.flags{color:var(--warn)}.review{font-style:italic}p{margin:4px 0}
table{width:100%;border-collapse:collapse;background:var(--card)}td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Property deals</h1><p class="muted">${deals.length} listing(s) priced below the local market · generated ${esc(generatedAt)}</p>
<div class="grid">${cards || '<p>No deals in this period.</p>'}</div>
<h2>Market (median price per ${unit === 'sqft' ? 'sq ft' : 'm²'}, sale)</h2>
<div class="wrap"><table><thead><tr><th>City</th><th>District</th><th>Type</th><th>Listings</th><th>Median</th><th>Middle 50 %</th></tr></thead><tbody>${rows}</tbody></table></div>
</main></body></html>`;
}

/**
 * Write reports. formats: xlsx, csv, json, html. Returns the written file paths.
 */
export async function writeReports(store, { out = path.join('data', 'deals-report'), formats = ['xlsx', 'html'], sinceDays = 14, unit = 'm2', windowDays = 90 } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const dealsL = store.deals({ status: ['deal'], sinceDays, limit: 1000 });
  const reviewL = store.deals({ status: ['suspicious', 'excluded'], sinceDays, limit: 1000 });
  const allL = store.listings({ sinceDays: windowDays, limit: 20000 });
  const market = marketSummary(allL);
  const data = { deals: rowsFor(dealsL, unit), review: rowsFor(reviewL, unit), all: rowsFor(allL, unit), market, unit };
  const files = [];
  for (const f of formats) {
    const file = `${out}.${f}`;
    if (f === 'xlsx') await writeXlsx(file, data);
    else if (f === 'csv') fs.writeFileSync(file, toCsv(data.deals));
    else if (f === 'json') fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), deals: data.deals, toCheck: data.review, market }, null, 2));
    else if (f === 'html') fs.writeFileSync(file, toHtml(dealsL, market, { unit, generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') }));
    else throw new Error(`Unknown report format "${f}" (xlsx, csv, json, html)`);
    files.push(path.resolve(file));
  }
  return files;
}
