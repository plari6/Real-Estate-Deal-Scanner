// Telegram bot (long polling, no webhook server needed): subscribe to alerts, personal filters,
// query deals and market prices from the phone, trigger a scan.
import { createTelegram, esc } from './telegram.js';
import { formatDealHtml } from './notify.js';
import { marketSummary } from './market.js';
import { formatMoney, formatPerArea, normText, parsePrice } from './parse.js';

const HELP = `<b>Real-Estate Deal Scanner</b>
I send you properties priced well below the local market average.

/deals [city] – best current deals
/top – the best deal in full
/market [city] – median price per m² by district
/threshold 25 – only alert me at 25 %+ below market
/cities Berlin,Hamburg – only these cities (/cities all = every city)
/maxprice 400000 – only up to this price (0 = no limit)
/status – last scan and totals
/scan – run a scan now (admins)
/stop – pause my alerts · /start – resume`;

export const COMMANDS = [
  ['deals', 'Best current deals'], ['top', 'The best deal in full'], ['market', 'Median price per m² by district'],
  ['threshold', 'My minimum discount, e.g. /threshold 25'], ['cities', 'Only these cities'], ['maxprice', 'Only up to this price'],
  ['status', 'Last scan and totals'], ['scan', 'Run a scan now'], ['stop', 'Pause my alerts'], ['help', 'Help'],
].map(([command, description]) => ({ command, description }));

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function createBot({ env = process.env, store, settings, onScan, fetchImpl = fetch, log = console.log, telegram } = {}) {
  const tg = telegram || createTelegram(env.TELEGRAM_BOT_TOKEN, { fetchImpl });
  if (!tg) return null;
  const admins = new Set([...list(env.TELEGRAM_CHAT_ID), ...list(env.TELEGRAM_ADMIN_IDS)]);
  const allowed = new Set([...admins, ...list(env.TELEGRAM_ALLOWED_CHATS)]);
  const open = /^(1|true|yes)$/i.test(env.BOT_OPEN || '');
  let running = false;
  let scanning = false;
  const unit = settings.areaUnit || 'm2';

  const reply = (chat, text, extra) => tg.sendMessage(chat, text, extra).catch((err) => log(`[bot] reply failed: ${err.message}`));

  function dealLine(l, i) {
    return `${i + 1}. <b>${Math.round((l.discount || 0) * 100)}%</b> below · ${esc(formatMoney(l.price, l.currency))} · ${l.area_m2 ? `${Math.round(l.area_m2)} m² · ` : ''}${esc(l.district || l.city || '')}\n   <a href="${esc(l.url)}">${esc((l.title || 'Listing').slice(0, 70))}</a> · score ${l.score}`;
  }

  async function handleCommand(chat, cmd, arg, from) {
    const sub = store.subscriber(chat);
    switch (cmd) {
      case 'start':
        store.subscribe(chat, from?.username || from?.first_name || null);
        return reply(chat, `✅ Alerts are on for this chat.\n\n${HELP}`);
      case 'help':
        return reply(chat, HELP);
      case 'stop':
        store.unsubscribe(chat);
        return reply(chat, '⏸ Alerts paused. Send /start to resume.');
      case 'deals': {
        const deals = store.deals({ city: arg || undefined, limit: 8, sinceDays: 14 }).filter((l) => !sub || !sub.max_price || l.price <= sub.max_price);
        if (!deals.length) return reply(chat, `No deals${arg ? ` in ${esc(arg)}` : ''} in the last 14 days.`);
        return reply(chat, `<b>Best deals${arg ? ` in ${esc(arg)}` : ''}</b>\n\n${deals.map(dealLine).join('\n\n')}`);
      }
      case 'top': {
        const [l] = store.deals({ city: arg || undefined, limit: 1, sinceDays: 14 });
        if (!l) return reply(chat, 'No deals yet.');
        const ev = { discount: l.discount, market: l.market, metric: l.metric, segment: l.segment, comps: l.comps, estimatedValue: l.estimated_value, savings: l.savings, confidence: l.confidence, score: l.score };
        return reply(chat, formatDealHtml({ type: 'new_deal', listing: l, ev, review: l.ai_review }, { areaUnit: unit }), { reply_markup: { inline_keyboard: [[{ text: 'Open listing', url: l.url }]] } });
      }
      case 'market': {
        const rows = marketSummary(store.listings({ sinceDays: settings.compsWindowDays || 90, limit: 20000 }))
          .filter((g) => g.deal_type === 'sale' && (!arg || normText(g.city) === normText(arg)))
          .slice(0, 25);
        if (!rows.length) return reply(chat, 'Not enough listings yet for market prices.');
        return reply(chat, `<b>Median asking price, sale</b>\n${rows.map((g) => `${g.district === 'All districts' ? `\n<b>${esc(g.city)} · ${esc(g.property_type)}</b>` : `• ${esc(g.district)}`}: ${esc(formatPerArea(g.median, g.currency, unit))} (${g.n})`).join('\n')}`);
      }
      case 'threshold': {
        const n = Number(String(arg).replace('%', ''));
        if (!arg || !Number.isFinite(n) || n < 0 || n > 90) return reply(chat, `Your threshold: ${sub?.min_discount != null ? `${Math.round(sub.min_discount * 100)}%` : `default (${Math.round(settings.dealThreshold * 100)}%)`}.\nUse /threshold 25`);
        store.subscribe(chat);
        store.updateSubscriber(chat, { min_discount: n > 1 ? n / 100 : n });
        return reply(chat, `✅ You get deals from ${n > 1 ? n : n * 100}% below market. (Listings below ${Math.round(settings.dealThreshold * 100)}% are never deals.)`);
      }
      case 'cities': {
        store.subscribe(chat);
        const v = /^(all|any|\*)$/i.test(arg) ? null : arg || null;
        store.updateSubscriber(chat, { cities: v });
        return reply(chat, v ? `✅ Only deals in: ${esc(v)}` : '✅ Deals in every city.');
      }
      case 'maxprice': {
        const n = parsePrice(arg)?.amount || 0; // "450.000", "450,000", "450k"
        store.subscribe(chat);
        store.updateSubscriber(chat, { max_price: n > 0 ? n : null });
        return reply(chat, n > 0 ? `✅ Only deals up to ${esc(formatMoney(n, settings.currency))}.` : '✅ No price limit.');
      }
      case 'status': {
        const c = store.counts();
        const s = store.lastScan();
        return reply(chat, [
          `<b>Status</b>`,
          `Listings: ${c.listings} from ${c.sources} source(s), ${c.cities} cit${c.cities === 1 ? 'y' : 'ies'}`,
          `Deals now: ${c.deals || 0} · held back as suspicious: ${c.suspicious || 0}`,
          s ? `Last scan: ${esc(s.finished_at.slice(0, 16).replace('T', ' '))} UTC · ${s.stats.listings} listings, ${s.stats.alerts} alert(s)${s.stats.failures?.length ? `, ${s.stats.failures.length} problem(s)` : ''}` : 'No scan yet.',
          `Rule: ≥ ${Math.round(settings.dealThreshold * 100)}% below the ${settings.marketStat} price per m² of at least ${settings.minComps} comparables.`,
        ].join('\n'));
      }
      case 'scan': {
        if (!admins.has(chat)) return reply(chat, 'Only admins can start a scan.');
        if (!onScan) return reply(chat, 'Scanning is not enabled in this process.');
        if (scanning) return reply(chat, '⏳ A scan is already running.');
        scanning = true;
        await reply(chat, '🔎 Scanning…');
        try {
          const s = await onScan();
          return reply(chat, `Done: ${s.listings} listings, ${s.deals} deal(s), ${s.alerts} new alert(s).`);
        } catch (err) {
          return reply(chat, `Scan failed: ${esc(err.message)}`);
        } finally {
          scanning = false;
        }
      }
      default:
        return reply(chat, HELP);
    }
  }

  async function handleUpdate(u) {
    const msg = u.message;
    if (!msg?.text) return;
    const chat = String(msg.chat.id);
    if (!open && !allowed.has(chat)) {
      // Private bot: tell the stranger their chat id so the owner can add it to TELEGRAM_ALLOWED_CHATS.
      return reply(chat, `This bot is private. Ask the owner to add your chat id <code>${esc(chat)}</code>.`);
    }
    const m = msg.text.trim().match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
    if (!m) return reply(chat, 'Send /help for the commands.');
    return handleCommand(chat, m[1].toLowerCase(), m[2].trim(), msg.from);
  }

  async function start() {
    running = true;
    await tg.setMyCommands(COMMANDS).catch(() => {});
    let offset = Number(store.kvGet('tg_offset') || 0);
    log('[bot] Telegram bot is listening (long polling)');
    while (running) {
      try {
        const updates = await tg.getUpdates(offset || undefined, 25);
        for (const u of updates) {
          offset = u.update_id + 1;
          store.kvSet('tg_offset', offset);
          await handleUpdate(u).catch((err) => log(`[bot] ${err.message}`));
        }
      } catch (err) {
        if (!running) break;
        log(`[bot] polling error: ${err.message}`);
        await new Promise((r) => setTimeout(r, err.code === 409 ? 30000 : 5000)); // 409 = another instance or a webhook
      }
    }
  }

  return { start, stop: () => { running = false; }, handleUpdate, handleCommand };
}
