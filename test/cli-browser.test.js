import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoPortals, demoSources } from '../src/demo.js';
import { createFetcher } from '../src/fetcher.js';
import { scanSource } from '../src/scanner.js';
import { getSettings } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'deal-scanner.js');
const env = { ...process.env, DEAL_SCANNER_SKIP_DOTENV: '1', PAGE_DELAY_MS: '50', TELEGRAM_BOT_TOKEN: '', GEMINI_API_KEY: '', GROQ_API_KEY: '', NVIDIA_API_KEY: '', OPENROUTER_API_KEY: '' };
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, cwd: ROOT, timeout: 120000 });

test('CLI: help, demo, deals, market, report, import, revalue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-cli-'));
  const db = path.join(dir, 'demo.db');
  assert.match(run(['help']).stdout, /deal-scanner <command>/);

  const demo = run(['demo', '--quiet', '--db', db]);
  assert.equal(demo.status, 0, demo.stderr);
  assert.match(demo.stdout, /Day 1: 108 listings, 4 alerts · Day 2: 2 alerts/);
  assert.match(demo.stdout, /demo-report\.xlsx/);
  assert.doesNotMatch(demo.stderr, /ExperimentalWarning/);

  const deals = run(['deals', '--db', db]);
  assert.match(deals.stdout, /Inheritance sale/);
  assert.match(deals.stdout, /https?:\/\/127\.0\.0\.1:\d+\/listing\//);
  assert.match(run(['market', '--db', db, '--city', 'Berlin']).stdout, /Kreuzberg/);
  const out = path.join(dir, 'r');
  const rep = run(['report', '--db', db, '--format', 'csv,json', '--out', out]);
  assert.equal(rep.status, 0, rep.stderr);
  assert.ok(fs.existsSync(`${out}.csv`) && fs.existsSync(`${out}.json`));
  assert.match(run(['revalue', '--db', db, '--threshold', '30']).stdout, /Re-valued 108 listings/);
  assert.match(run(['alerts', '--db', db]).stdout, /price_drop/);

  const csv = path.join(dir, 'x.csv');
  fs.writeFileSync(csv, 'url;price;area;rooms;district\nhttps://x.example/1;250.000 €;60 m²;2;Mitte\n');
  const imp = run(['import', csv, '--db', db, '--city', 'Berlin']);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /Imported 1\/1 rows/);
  assert.match(run(['nope']).stdout, /Unknown command/);
});

test('CLI: test-source on a live-like URL, and scan --dry-run with a sources file', async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-cli-'));
  // spawnSync would block the event loop that serves the fake portals, so use async spawn.
  const { spawn } = await import('node:child_process');
  const runAsync = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: ROOT });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const ts = await runAsync(['test-source', `${portals.base}/b/search`, '--engine', 'http']);
  assert.equal(ts.status, 0, ts.stderr);
  assert.match(ts.stdout, /using embedded/);
  assert.match(ts.stdout, /listings: 13 \(13 with living area/);

  const sources = path.join(dir, 'sources.json');
  fs.writeFileSync(sources, JSON.stringify({ sources: demoSources(portals.base) }));
  const scan = await runAsync(['scan', '--sources', sources, '--db', path.join(dir, 's.db'), '--dry-run', '--no-notify']);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /108 listings/);
});

// Real headless Chrome through Puppeteer Stealth (skipped when Chrome is not installed).
let chromeOk = false;
try {
  const { default: puppeteer } = await import('puppeteer');
  chromeOk = fs.existsSync(await puppeteer.executablePath());
} catch { /* not installed */ }

test('Puppeteer engine reads a JavaScript-rendered portal (Next.js shell)', { skip: !chromeOk && 'Chrome not installed' }, async (t) => {
  const portals = await startDemoPortals();
  t.after(() => portals.close());
  const settings = { ...getSettings({}), pageDelayMs: 0 };
  const fetcher = createFetcher(settings);
  t.after(() => fetcher.close());
  const [, nestly, classic] = demoSources(portals.base);
  const r = await scanSource({ ...nestly, engine: 'browser', pages: 1 }, { fetcher, settings, store: null });
  assert.equal(r.pages[0].engine, 'browser');
  assert.equal(r.listings.length, 13);
  const c = await scanSource({ ...classic, engine: 'browser', pages: 1, scrolls: 1 }, { fetcher, settings, store: null });
  assert.equal(c.listings.length, 13);
  assert.ok(fetcher.browserUsed);
});
