import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { importFile, parseCsv } from '../src/importer.js';
import { openDb } from '../src/db.js';
import { getSettings } from '../src/config.js';
import { revalueAll } from '../src/scanner.js';
import { writeReports } from '../src/report.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deal-scanner-'));

test('parseCsv: ; and , delimiters, quotes, BOM', () => {
  const rows = parseCsv('\ufeffurl;price;title\n"https://a.example/1";"349.000 €";"Flat; nice ""view"""\n');
  assert.deepEqual(rows, [{ url: 'https://a.example/1', price: '349.000 €', title: 'Flat; nice "view"' }]);
  assert.equal(parseCsv('a,b\n1,2\n')[0].b, '2');
});

test('import CSV export (sq ft, bedrooms, coordinates) then value and report', async () => {
  const dir = tmp();
  const lines = ['Listing URL,Price,Sqft,Beds,Neighborhood,City,Lat,Lng,Home Type'];
  for (let i = 0; i < 8; i++) lines.push(`https://zil.example/h/${i},"$${600 + i * 5},000",1500,3,Midtown,Austin,30.27,-97.74,Single Family`);
  lines.push('https://zil.example/h/deal,"$420,000",1500,3,Midtown,Austin,30.271,-97.741,Single Family');
  lines.push(',"$1",1500,3,Midtown,Austin,,,House'); // no link -> skipped
  const file = path.join(dir, 'export.csv');
  fs.writeFileSync(file, lines.join('\n'));
  const { listings, skipped, total } = importFile(file, { sourceName: 'zil-export', currency: 'USD' });
  assert.equal(total, 10);
  assert.equal(skipped, 1);
  assert.equal(listings[0].area_m2, 139.4);
  assert.equal(listings[0].currency, 'USD');
  assert.equal(listings[0].property_type, 'house');
  assert.equal(listings[0].district, 'Midtown');

  const store = openDb(path.join(dir, 'd.db'));
  for (const l of listings) store.upsertListing(l);
  const counts = revalueAll(store, getSettings({}));
  assert.equal(counts.deal, 1);
  const [deal] = store.deals();
  assert.equal(deal.url, 'https://zil.example/h/deal');
  assert.match(deal.segment, /within 1.5 km/);

  const files = await writeReports(store, { out: path.join(dir, 'report'), formats: ['xlsx', 'csv', 'json', 'html'] });
  assert.equal(files.length, 4);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(files[0]);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Deals', 'To check', 'All listings', 'Market']);
  const ws = wb.getWorksheet('Deals');
  const header = ws.getRow(1).values;
  const linkCol = header.indexOf('Link');
  assert.equal(ws.getRow(2).getCell(linkCol).value.hyperlink, 'https://zil.example/h/deal');
  const csv = fs.readFileSync(files[1], 'utf8');
  assert.ok(csv.startsWith('\ufeffScore;'));
  assert.match(csv, /https:\/\/zil\.example\/h\/deal/);
  const json = JSON.parse(fs.readFileSync(files[2], 'utf8'));
  assert.equal(json.deals.length, 1);
  assert.match(fs.readFileSync(files[3], 'utf8'), /Property deals[\s\S]*zil\.example\/h\/deal/);
  store.close();
});

test('JSON / JSONL import (Apify-style dataset)', () => {
  const dir = tmp();
  const file = path.join(dir, 'items.jsonl');
  fs.writeFileSync(file, [JSON.stringify({ url: 'https://p.example/1', price: 'AED 1.2M', size: '1,100 sqft', bedrooms: 2, location: 'Marina Gate, Dubai Marina, Dubai' }), JSON.stringify({ link: 'https://p.example/2', price: 900000 })].join('\n'));
  const { listings } = importFile(file, { defaults: { city: 'Dubai', currency: 'AED' } });
  assert.equal(listings.length, 2);
  assert.equal(listings[0].price, 1200000);
  assert.equal(listings[0].area_m2, 102.2);
  assert.equal(listings[0].district, 'Dubai Marina');
});
