// Command line interface. Run `deal-scanner help` for the list of commands.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, getSettings, loadEnv, loadSources, pageUrl } from './config.js';
import { openDb } from './db.js';
import { runScan, revalueAll } from './scanner.js';
import { createChannels, dispatch, formatSummaryText } from './notify.js';
import { writeReports } from './report.js';
import { marketSummary } from './market.js';
import { importFile } from './importer.js';
import { createFetcher } from './fetcher.js';
import { extractListings } from './adapters/index.js';
import { createBot } from './bot.js';
import { createTelegram } from './telegram.js';
import { flagLabel } from './flags.js';
import { formatArea, formatMoney, formatPerArea, roomsLabel } from './parse.js';

const HELP = `Real-Estate Deal Scanner - finds properties priced 20 %+ below the local market and alerts on Telegram.

Usage: deal-scanner <command> [options]

  demo [--browser] [--notify]       offline demo: 3 fake portals, 2 days, report in data/demo-report.*
  init                              create sources.json and .env from the examples
  test-source <name|url> [--engine http|browser] [--adapter auto|jsonld|embedded|css|cards|ai] [--json]
                                    which adapter reads a search page and what it finds (use before adding a portal)
  scan [--source name] [--dry-run] [--no-notify] [--threshold 25]
                                    scan all sources once, value listings, send alerts
  start [--cron "0 */3 * * *"] [--run-now] [--no-bot] [--health-port 8080]
                                    scheduler + Telegram bot + /health (for a server / Docker)
  bot                               Telegram bot only (commands, no scheduled scans)
  deals [--city X] [--min 25] [--limit 20] [--all]
  market [--city X]                 median price per m² by district
  report [--format xlsx,html,csv,json] [--out data/deals-report] [--days 14]
  import <file.csv|json|jsonl> [--source name] [--city X] [--currency EUR]
                                    add listings from an export (Apify, portal export, MLS) and re-value
  revalue                           re-value all recent listings with the current rules (no alerts)
  alerts [--limit 20]               alerts sent so far
  notify-test                       send a sample deal to every configured channel
  doctor [--ping]                   check config, Chrome, Telegram and the AI models
  sources                           list configured sources

Global: --db <file> (default data/deals.db)  --sources <file> (default sources.json)  --simulate-outage gemini,groq`;

const OPTIONS = {
  db: { type: 'string' }, sources: { type: 'string' }, source: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-notify': { type: 'boolean' },
  threshold: { type: 'string' }, cron: { type: 'string' }, 'run-now': { type: 'boolean' }, 'no-bot': { type: 'boolean' }, 'health-port': { type: 'string' },
  city: { type: 'string' }, min: { type: 'string' }, limit: { type: 'string' }, all: { type: 'boolean' }, format: { type: 'string' }, out: { type: 'string' },
  days: { type: 'string' }, currency: { type: 'string' }, engine: { type: 'string' }, adapter: { type: 'string' }, json: { type: 'boolean' },
  browser: { type: 'boolean' }, notify: { type: 'boolean' }, ping: { type: 'boolean' }, 'simulate-outage': { type: 'string' }, quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

async function makeAI(env, outage) {
  const keys = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL'];
  if (!keys.some((k) => env[k])) return null;
  const { createRouterFromEnv } = await import('./ai/index.js');
  const ai = createRouterFromEnv(env, {
    simulate: outage ? outage.split(',') : [],
    onEvent: (e) => e.type === 'failure' && console.warn(`[ai] ${e.target} ${e.kind} -> next model`),
  });
  return ai;
}

function settingsFrom(values, env) {
  const s = getSettings(env);
  if (values.db) s.dbPath = path.resolve(values.db);
  if (values.sources) s.sourcesPath = path.resolve(values.sources);
  if (values.threshold) { const n = Number(values.threshold); s.dealThreshold = n > 1 ? n / 100 : n; }
  if (values.engine) s.engine = values.engine;
  return s;
}

function printDeals(deals, unit) {
  if (!deals.length) return console.log('No deals yet. Run `deal-scanner scan` (or `demo`).');
  for (const l of deals) {
    const flags = (l.flags || []).filter((f) => f !== 'no_area').map(flagLabel).join(', ');
    console.log(`\n${String(l.score).padStart(3)}  ${Math.round((l.discount || 0) * 100)}% below  ${l.title || '(no title)'}${l.deal_status !== 'deal' ? `  [${l.deal_status}]` : ''}`);
    console.log(`     ${formatMoney(l.price, l.currency)} · ${formatArea(l.area_m2, unit)} · ${roomsLabel(l.rooms)} · ${[l.district, l.city].filter(Boolean).join(', ')} · ${l.source}`);
    if (l.metric === 'm2') console.log(`     ${formatPerArea(l.price_m2, l.currency, unit)} vs ${formatPerArea(l.market, l.currency, unit)} (${l.segment}, ${l.comps} comps) · est. ${formatMoney(l.estimated_value, l.currency)}`);
    if (flags) console.log(`     ⚠ ${flags}`);
    if (l.ai_review?.summary) console.log(`     ${l.ai_review.summary}`);
    console.log(`     ${l.url}`);
  }
}

function printMarket(rows, unit) {
  if (!rows.length) return console.log('Not enough listings for market prices yet.');
  const k = unit === 'sqft' ? 0.09290304 : 1;
  console.log(`${'City'.padEnd(14)}${'District'.padEnd(22)}${'Type'.padEnd(12)}${'Deal'.padEnd(6)}${'N'.padStart(5)}  ${`Median/${unit === 'sqft' ? 'sqft' : 'm²'}`.padStart(13)}  Middle 50 %`);
  for (const g of rows) {
    console.log(`${g.city.slice(0, 13).padEnd(14)}${String(g.district).slice(0, 21).padEnd(22)}${g.property_type.padEnd(12)}${g.deal_type.padEnd(6)}${String(g.n).padStart(5)}  ${formatMoney(g.median * k, g.currency).padStart(13)}  ${formatMoney(g.p25 * k, g.currency)} – ${formatMoney(g.p75 * k, g.currency)}`);
  }
}

async function cmdDemo(values, env) {
  const { startDemoPortals, demoSources } = await import('./demo.js');
  const settings = { ...getSettings({ ...env, DB_PATH: undefined }), pageDelayMs: 100, respectRobots: true, engine: values.browser ? 'browser' : 'auto' };
  settings.dbPath = path.resolve(values.db || path.join(ROOT, 'data', 'demo.db'));
  for (const f of [settings.dbPath, `${settings.dbPath}-wal`, `${settings.dbPath}-shm`]) fs.rmSync(f, { force: true });
  const store = openDb(settings.dbPath);
  const portals = await startDemoPortals();
  const sources = demoSources(portals.base);
  // The demo prints to the console; --notify also sends to your real Telegram/Slack/webhook.
  const channels = createChannels(values.notify ? env : {}, { store, settings });
  const ai = values.notify ? await makeAI(env, values['simulate-outage']) : null;
  console.log(`Demo portals on ${portals.base} (HomeFinder = JSON-LD, Nestly = Next.js JSON, ClassicImmo = HTML cards)${values.browser ? ' · engine: Puppeteer' : ''}\n`);
  try {
    console.log('━━ Day 1: first scan ━━');
    const s1 = await runScan({ store, sources, settings, ai, channels, log: (m) => !values.quiet && console.log(m) });
    portals.setDay(2);
    console.log('\n━━ Day 2: prices changed, same scan again (known deals are not re-sent) ━━');
    const s2 = await runScan({ store, sources, settings, ai, channels, log: () => {} });
    const files = await writeReports(store, { out: path.join(ROOT, 'data', 'demo-report'), formats: ['xlsx', 'html', 'csv', 'json'], unit: settings.areaUnit });
    console.log('\n━━ Held back / excluded (not alerted) ━━');
    printDeals(store.deals({ status: ['suspicious', 'excluded'], limit: 10 }), settings.areaUnit);
    console.log(`\nDay 1: ${s1.listings} listings, ${s1.alerts} alerts · Day 2: ${s2.alerts} alerts (${s2.priceDrops} price change(s))`);
    console.log(`Reports:\n  ${files.join('\n  ')}`);
    return { s1, s2, files };
  } finally {
    await portals.close();
    store.close();
  }
}

async function cmdTestSource(target, values, env, settings) {
  if (!target) throw new Error('Usage: deal-scanner test-source <source name | url>');
  let source;
  if (/^https?:\/\//.test(target)) source = { name: new URL(target).hostname, url: target, pages: 1, defaults: { currency: settings.currency } };
  else {
    source = loadSources(settings.sourcesPath).find((s) => s.name === target);
    if (!source) throw new Error(`No source named "${target}" in ${settings.sourcesPath}`);
  }
  if (values.adapter) source = { ...source, adapter: values.adapter };
  const ai = await makeAI(env, values['simulate-outage']);
  const fetcher = createFetcher({ ...settings, pageDelayMs: 0 }, { log: console.log });
  try {
    const url = pageUrl(source, 1);
    const res = await fetcher.fetchHtml(url, { engine: values.engine || source.engine || 'auto', waitForSelector: source.waitForSelector || source.selectors?.card, scrolls: source.scrolls || 0 });
    let ex = await extractListings(res.body, res.url || url, source, { ai, aiExtract: settings.aiExtract, currency: settings.currency, log: console.log });
    let engine = res.engine;
    if (!ex.listings.length && res.engine === 'http' && !values.engine) {
      console.log('Nothing in the plain HTML, trying the browser…');
      const r2 = await fetcher.fetchHtml(url, { engine: 'browser', waitForSelector: source.selectors?.card, scrolls: source.scrolls || 0 });
      ex = await extractListings(r2.body, r2.url || url, source, { ai, aiExtract: settings.aiExtract, currency: settings.currency, log: console.log });
      engine = 'browser';
    }
    if (values.json) return console.log(JSON.stringify({ url, engine, ...ex }, null, 2));
    console.log(`\n${url}\nengine: ${engine} · HTTP ${res.status} · ${Math.round(res.body.length / 1024)} KB`);
    console.log(`adapters: ${ex.tried.map((t) => `${t.adapter}=${t.count}`).join('  ')}  → using ${ex.method || 'none'}`);
    const withArea = ex.listings.filter((l) => l.area_m2).length;
    console.log(`listings: ${ex.listings.length} (${withArea} with living area, ${ex.listings.filter((l) => l.district).length} with district, ${ex.listings.filter((l) => l.rooms != null).length} with rooms)\n`);
    for (const l of ex.listings.slice(0, 5)) {
      console.log(`• ${l.title || '(no title)'}\n  ${formatMoney(l.price, l.currency)}${l.deal_type === 'rent' ? '/month' : ''} · ${formatArea(l.area_m2, settings.areaUnit)} · ${roomsLabel(l.rooms)} · ${[l.district, l.city].filter(Boolean).join(', ') || '?'} · ${l.property_type}\n  ${l.url}`);
    }
    if (!ex.listings.length) console.log('Nothing found. Add "selectors" for this source (see README), or set an AI key so the AI adapter can read the page.');
    else if (!withArea) console.log('\nNo living area found: comparisons will use total price by room count. Add a "selectors.area" or "fieldMap.area" if the cards show it.');
    else if (!ex.listings.some((l) => l.district)) console.log('\nNo district found: the market average will be city-wide. Set "defaults.district" for a district search, or a "selectors.location".');
  } finally {
    await fetcher.close();
  }
}

async function cmdDoctor(values, env, settings) {
  const ok = (b, msg) => console.log(`${b ? '✔' : '✖'} ${msg}`);
  ok(Number(process.versions.node.split('.')[0]) >= 22, `Node ${process.versions.node}`);
  let sources = [];
  try { sources = loadSources(settings.sourcesPath); ok(sources.length > 0, `${sources.length} source(s) in ${settings.sourcesPath}`); } catch (err) { ok(false, err.message); }
  ok(true, `database ${settings.dbPath}`);
  let chrome = settings.chromePath;
  if (!chrome) { try { const { default: p } = await import('puppeteer'); chrome = await p.executablePath(); } catch { chrome = null; } }
  ok(Boolean(chrome && fs.existsSync(chrome)), `Chrome for Puppeteer: ${chrome || 'not found (npm rebuild puppeteer, or set CHROME_PATH)'}`);
  const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
  if (!tg) ok(false, 'Telegram: TELEGRAM_BOT_TOKEN not set (alerts go to the console only)');
  else {
    try { const me = await tg.getMe(); ok(true, `Telegram bot @${me.username}`); } catch (err) { ok(false, `Telegram: ${err.message}`); }
    ok(Boolean(env.TELEGRAM_CHAT_ID), `TELEGRAM_CHAT_ID ${env.TELEGRAM_CHAT_ID || 'not set: send /start to the bot, it replies with your chat id'}`);
  }
  console.log(`  rule: ${Math.round(settings.dealThreshold * 100)}% below the ${settings.marketStat} of ≥ ${settings.minComps} comparables · excluded flags: ${settings.excludeFlags.join(', ') || 'none'}`);
  const ai = await makeAI(env, values['simulate-outage']);
  if (!ai) return ok(true, 'AI: no keys set (optional; keyword rules are used for reviews)');
  for (const t of ai.status()) {
    let line = `${t.id}: ${t.state}${t.lastError ? ` (${t.lastError})` : ''}`;
    if (values.ping && t.state !== 'disabled') {
      try { const r = await ai.generate({ only: t.id, messages: [{ role: 'user', content: 'Reply with OK' }], maxTokens: 1024, timeoutMs: 15000 }); line += ` · ping ${r.ms ?? ''}ms "${r.text.trim().slice(0, 20)}"`; } catch (err) { line += ` · ping failed: ${err.message.slice(0, 80)}`; }
    }
    console.log(`  ${line}`);
  }
}

function startHealth(port, store, ai) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404); return res.end(); }
    const last = store.lastScan();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lastScan: last ? { finishedAt: last.finished_at, ...last.stats, topDeals: undefined, perSource: undefined } : null, counts: store.counts(), ai: ai?.status?.() || null }));
  });
  server.listen(port, () => console.log(`[health] http://localhost:${port}/health`));
  return server;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  await loadEnv();
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false });
  const [cmd = 'help', ...rest] = positionals;
  if (values.help || cmd === 'help') return console.log(HELP);
  const settings = settingsFrom(values, env);

  if (cmd === 'demo') return cmdDemo(values, env);
  if (cmd === 'init') {
    for (const [from, to] of [['examples/sources.example.json', 'sources.json'], ['.env.example', '.env']]) {
      const dst = path.join(ROOT, to);
      if (fs.existsSync(dst)) console.log(`exists: ${dst}`);
      else { fs.copyFileSync(path.join(ROOT, from), dst); console.log(`created: ${dst}`); }
    }
    return console.log('Next: edit sources.json (your portal searches), put your Telegram token in .env, then run `deal-scanner test-source <name>`.');
  }
  if (cmd === 'test-source') return cmdTestSource(rest[0], values, env, settings);
  if (cmd === 'doctor') return cmdDoctor(values, env, settings);
  if (cmd === 'sources') {
    for (const s of loadSources(settings.sourcesPath)) console.log(`${s.name.padEnd(22)} ${String(s.pages).padStart(2)} page(s)  ${s.engine.padEnd(7)} ${s.selectors ? 'css' : s.adapter}  ${s.url}`);
    return;
  }

  const store = openDb(settings.dbPath);
  try {
    switch (cmd) {
      case 'scan': {
        let sources = loadSources(settings.sourcesPath);
        if (values.source) sources = sources.filter((s) => values.source.split(',').includes(s.name));
        if (!sources.length) throw new Error('No sources to scan');
        const ai = await makeAI(env, values['simulate-outage']);
        const channels = values['no-notify'] ? createChannels({}, { store, settings }) : createChannels(env, { store, settings });
        const s = await runScan({ store, sources, settings, ai, channels, dryRun: values['dry-run'] });
        if (values.json) console.log(JSON.stringify(s, null, 2));
        else if (values['dry-run']) {
          console.log(`\n${formatSummaryText(s)}\n(dry run: nothing sent, nothing marked as alerted)`);
          printDeals(store.deals({ limit: 10 }), settings.areaUnit);
        }
        if (s.sourcesOk === 0) process.exitCode = 2;
        return s;
      }
      case 'deals':
        return printDeals(store.deals({ status: values.all ? ['deal', 'suspicious', 'excluded'] : ['deal'], city: values.city, minDiscount: values.min ? Number(values.min) / (Number(values.min) > 1 ? 100 : 1) : 0, limit: Number(values.limit || 20), sinceDays: Number(values.days || 14) }), settings.areaUnit);
      case 'market':
        return printMarket(marketSummary(store.listings({ sinceDays: settings.compsWindowDays, limit: 50000 })).filter((g) => !values.city || g.city.toLowerCase() === values.city.toLowerCase()), settings.areaUnit);
      case 'report': {
        const files = await writeReports(store, { out: values.out || path.join(ROOT, 'data', 'deals-report'), formats: (values.format || 'xlsx,html').split(','), sinceDays: Number(values.days || 14), unit: settings.areaUnit, windowDays: settings.compsWindowDays });
        return console.log(files.join('\n'));
      }
      case 'import': {
        if (!rest[0]) throw new Error('Usage: deal-scanner import <file.csv|json|jsonl> [--source name] [--city X]');
        const { listings, skipped, total } = importFile(rest[0], { sourceName: values.source, defaults: { city: values.city, currency: values.currency || settings.currency }, currency: values.currency || settings.currency });
        const stamp = new Date().toISOString();
        for (const l of listings) store.upsertListing(l, stamp);
        const counts = revalueAll(store, settings);
        console.log(`Imported ${listings.length}/${total} rows (${skipped} skipped: no link or no price). Re-valued ${counts.listings}: ${counts.deal} deal(s), ${counts.suspicious} suspicious, ${counts.unrated} unrated.`);
        return printDeals(store.deals({ limit: 10 }), settings.areaUnit);
      }
      case 'revalue': {
        const c = revalueAll(store, settings);
        return console.log(`Re-valued ${c.listings} listings: ${c.deal} deal, ${c.suspicious} suspicious, ${c.excluded} excluded, ${c.fair} fair, ${c.unrated} unrated.`);
      }
      case 'alerts':
        for (const a of store.alerts(Number(values.limit || 20))) console.log(`${a.created_at.slice(0, 16)}  ${a.type.padEnd(10)} ${Math.round((a.discount || 0) * 100)}%  score ${a.score}  ${a.title}  ${a.url}  → ${a.channels || 'none'}`);
        return;
      case 'notify-test': {
        const channels = createChannels(env, { store, settings });
        const sample = {
          type: 'new_deal',
          listing: { uid: 'test:1', source: 'test', url: 'https://example.com/listing/1', title: 'Test: bright 3-room apartment (sample alert)', price: 359000, currency: settings.currency, deal_type: 'sale', area_m2: 82, rooms: 3, property_type: 'apartment', city: 'Berlin', district: 'Kreuzberg', price_m2: 4378, flags: [] },
          ev: { status: 'deal', discount: 0.32, market: 6449, metric: 'm2', segment: 'Kreuzberg · apartment', comps: 19, estimatedValue: 528816, savings: 169816, confidence: 0.86, score: 83, reasons: [] },
          review: { verdict: 'strong', summary: 'This is a test message from the deal scanner.', checks: [] },
        };
        const ok = await dispatch(channels, 'send', sample);
        return console.log(`Sent to: ${ok.join(', ') || 'nothing'}${channels.some((c) => c.name === 'telegram') ? '' : '  (Telegram not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)'}`);
      }
      case 'bot':
      case 'start': {
        const ai = await makeAI(env, values['simulate-outage']);
        const channels = createChannels(env, { store, settings });
        let busy = null;
        const scanOnce = async () => {
          if (busy) return busy;
          busy = (async () => {
            const sources = loadSources(settings.sourcesPath);
            return runScan({ store, sources, settings, ai, channels });
          })().finally(() => { busy = null; });
          return busy;
        };
        const bot = values['no-bot'] ? null : createBot({ env, store, settings, onScan: scanOnce });
        if (cmd === 'bot' && !bot) throw new Error('TELEGRAM_BOT_TOKEN is not set');
        const tasks = [];
        if (cmd === 'start') {
          const cron = (await import('node-cron')).default;
          const expr = values.cron || settings.cron;
          if (!cron.validate(expr)) throw new Error(`Invalid cron expression "${expr}"`);
          cron.schedule(expr, () => scanOnce().catch((err) => console.error(`[scan] ${err.message}`)), { timezone: settings.timezone });
          console.log(`[scheduler] scanning on "${expr}" (${settings.timezone})`);
          const port = Number(values['health-port'] || env.HEALTH_PORT || 0);
          if (port) startHealth(port, store, ai);
          if (values['run-now']) tasks.push(scanOnce().catch((err) => console.error(`[scan] ${err.message}`)));
        }
        if (bot) tasks.push(bot.start());
        else if (cmd === 'start') console.log('[bot] Telegram commands off (no token or --no-bot); alerts still go to configured channels');
        await Promise.all(tasks);
        if (cmd === 'start') await new Promise(() => {}); // keep the scheduler alive
        return;
      }
      default:
        console.log(`Unknown command "${cmd}"\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    if (!['start', 'bot'].includes(cmd)) store.close();
  }
}
