import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannels, dispatch, formatDealHtml, subscriberWants } from '../src/notify.js';
import { createBot } from '../src/bot.js';
import { openDb } from '../src/db.js';
import { getSettings } from '../src/config.js';

const alert = (o = {}) => ({
  type: 'new_deal',
  listing: { id: 1, uid: 's:1', source: 'homefinder', url: 'https://portal.example/l/1', title: 'Flat <b>& more</b>', price: 359000, currency: 'EUR', deal_type: 'sale', area_m2: 82, rooms: 3, property_type: 'apartment', city: 'Berlin', district: 'Kreuzberg', price_m2: 4378, flags: ['renovation'], image: 'https://portal.example/img/1.jpg', ...o.listing },
  ev: { status: 'deal', discount: 0.32, market: 6449, metric: 'm2', segment: 'within 1.5 km · apartment', comps: 19, estimatedValue: 528816, savings: 169816, confidence: 0.86, score: 83, reasons: [] },
  review: { verdict: 'check', summary: 'Needs a new bathroom.', checks: ['Get a quote'] },
  ...o,
});

/** Fake fetch that records Telegram / webhook calls. */
function fakeFetch({ photoFails = false, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (photoFails && url.endsWith('/sendPhoto')) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'wrong file' }), { status: 400 });
    if (url.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status });
    return new Response('ok', { status });
  };
  return { calls, impl };
}

test('Telegram deal card: escaped HTML, photo with an Open listing button, text fallback', async () => {
  const html = formatDealHtml(alert());
  assert.match(html, /32% below market/);
  assert.match(html, /Flat &lt;b&gt;&amp; more&lt;\/b&gt;/);
  assert.match(html, /€169,816/);
  assert.match(html, /Needs renovation/);
  assert.match(html, /Check first/);

  const f = fakeFetch({ photoFails: true });
  const channels = createChannels({ TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '111,222' }, { fetchImpl: f.impl, quiet: true });
  const ok = await dispatch(channels, 'send', alert());
  assert.deepEqual(ok, ['telegram']);
  const photos = f.calls.filter((c) => c.url.endsWith('/sendPhoto'));
  const msgs = f.calls.filter((c) => c.url.endsWith('/sendMessage'));
  assert.equal(photos.length, 2);
  assert.equal(msgs.length, 2, 'falls back to text when the photo is refused');
  assert.deepEqual(msgs.map((m) => m.body.chat_id), ['111', '222']);
  assert.equal(msgs[0].body.parse_mode, 'HTML');
  assert.equal(msgs[0].body.reply_markup.inline_keyboard[0][0].url, 'https://portal.example/l/1');
});

test('subscribers get only deals matching their filters; blocked bots unsubscribe', async () => {
  const store = openDb(':memory:');
  store.subscribe('500', 'ann');
  store.updateSubscriber('500', { min_discount: 0.35 });
  store.subscribe('600', 'bob');
  store.updateSubscriber('600', { cities: 'Berlin, Hamburg', max_price: 400000 });
  assert.equal(subscriberWants(store.subscriber('500'), alert()), false);
  assert.equal(subscriberWants(store.subscriber('600'), alert()), true);
  assert.equal(subscriberWants(store.subscriber('600'), alert({ listing: { city: 'Munich' } })), false);
  const f = fakeFetch();
  const ch = createChannels({ TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_PHOTOS: 'false' }, { store, fetchImpl: f.impl, quiet: true });
  await dispatch(ch, 'send', alert());
  assert.deepEqual(f.calls.map((c) => c.body.chat_id), ['600']);
  store.close();
});

test('webhook payload for n8n / Make / CRM, with secret header; failing channel does not block others', async () => {
  const f = fakeFetch();
  const ch = createChannels({ ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_WEBHOOK_SECRET: 's3' }, { fetchImpl: f.impl, quiet: true });
  await dispatch(ch, 'send', alert());
  const [call] = f.calls;
  assert.equal(call.headers['X-Deal-Scanner-Secret'], 's3');
  assert.equal(call.body.event, 'new_deal');
  assert.equal(call.body.listing.url, 'https://portal.example/l/1');
  assert.equal(call.body.valuation.discount, 0.32);
  const broken = { name: 'broken', send: async () => { throw new Error('down'); }, summary: async () => {} };
  const ok = await dispatch([broken, ...ch], 'send', alert(), { warn: () => {} });
  assert.deepEqual(ok, ['webhook']);
});

test('Telegram bot commands: private by default, subscribe, filters, deals, status, admin-only scan', async () => {
  const store = openDb(':memory:');
  const settings = getSettings({});
  const sent = [];
  const telegram = { sendMessage: async (chat, text) => { sent.push({ chat, text }); return {}; } };
  let scans = 0;
  const bot = createBot({ env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', TELEGRAM_ALLOWED_CHATS: '2' }, store, settings, telegram, onScan: async () => { scans++; return { listings: 10, deals: 1, alerts: 1 }; }, log: () => {} });
  const say = (chat, text) => bot.handleUpdate({ message: { chat: { id: chat }, text, from: { username: 'u' } } });
  const last = () => sent[sent.length - 1].text;

  await say(99, '/start');
  assert.match(last(), /private.*99/s);
  await say(2, '/start');
  assert.match(last(), /Alerts are on/);
  assert.equal(store.subscriber('2').active, 1);
  await say(2, '/threshold 30');
  assert.equal(store.subscriber('2').min_discount, 0.3);
  await say(2, '/cities Berlin');
  assert.equal(store.subscriber('2').cities, 'Berlin');
  await say(2, '/maxprice 450.000');
  assert.equal(store.subscriber('2').max_price, 450000);
  await say(2, '/deals');
  assert.match(last(), /No deals/);
  // Add a deal and ask again.
  const { listing } = store.upsertListing({ uid: 's:1', source: 's', url: 'https://p.example/1', title: 'Cheap flat', price: 300000, currency: 'EUR', deal_type: 'sale', area_m2: 70, rooms: 2, property_type: 'apartment', city: 'Berlin', district: 'Mitte', price_m2: 4286, flags: [] });
  store.saveEvaluation(listing.id, { status: 'deal', discount: 0.3, market: 6100, metric: 'm2', segment: 'Mitte · apartment', comps: 9, score: 77, estimatedValue: 427000, savings: 127000, confidence: 0.8 });
  await say(2, '/deals');
  assert.match(last(), /30%<\/b> below.*Cheap flat/s);
  await say(2, '/top');
  assert.match(last(), /Cheap flat/);
  await say(2, '/status');
  assert.match(last(), /Deals now: 1/);
  await say(2, '/scan');
  assert.match(last(), /Only admins/);
  await say(1, '/scan');
  assert.equal(scans, 1);
  assert.match(last(), /Done: 10 listings/);
  await say(2, '/stop');
  assert.equal(store.subscriber('2').active, 0);
  await say(2, 'hello');
  assert.match(last(), /\/help/);
  store.close();
});
