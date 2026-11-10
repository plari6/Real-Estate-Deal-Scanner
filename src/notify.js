// Alert delivery: console, Telegram (env chats + bot subscribers with personal filters), Slack, JSON webhook.
// A failing channel never blocks the others.
import { createTelegram, esc } from './telegram.js';
import { flagLabel } from './flags.js';
import { formatArea, formatMoney, formatPerArea, normText, roomsLabel } from './parse.js';

const pct = (x) => `${Math.round((x || 0) * 100)}%`;

/** Plain-text deal card (console, Slack fallback, email). */
export function formatDealText(a, { areaUnit = 'm2' } = {}) {
  const { listing: l, ev } = a;
  const head = a.type === 'price_drop' ? `PRICE DROP · now ${pct(ev.discount)} below market` : `${pct(ev.discount)} below market`;
  const lines = [
    `${head} · score ${ev.score}/100`,
    l.title || '(no title)',
    `${formatMoney(l.price, l.currency)}${l.deal_type === 'rent' ? '/month' : ''} · ${formatArea(l.area_m2, areaUnit)} · ${roomsLabel(l.rooms)} · ${[l.district, l.city].filter(Boolean).join(', ')}`,
    ev.metric === 'm2'
      ? `${formatPerArea(l.price_m2, l.currency, areaUnit)} vs market ${formatPerArea(ev.market, l.currency, areaUnit)} (${ev.segment}, ${ev.comps} comps)`
      : `vs market ${formatMoney(ev.market, l.currency)} (${ev.segment}, ${ev.comps} comps)`,
    `Estimated value ${formatMoney(ev.estimatedValue, l.currency)} → ${formatMoney(ev.savings, l.currency)} below`,
  ];
  if (a.prevPrice) lines.push(`Was ${formatMoney(a.prevPrice, l.currency)} (−${pct(1 - l.price / a.prevPrice)})`);
  const flags = (l.flags || []).filter((f) => f !== 'no_area');
  if (flags.length) lines.push(`Flags: ${flags.map(flagLabel).join(', ')}`);
  if (a.review?.summary) lines.push(`Review: ${a.review.summary}`);
  lines.push(l.url);
  return lines.join('\n');
}

export function formatDealHtml(a, { areaUnit = 'm2' } = {}) {
  const { listing: l, ev } = a;
  const icon = ev.score >= 75 ? '🔥' : ev.score >= 55 ? '✅' : '🔎';
  const head = a.type === 'price_drop' ? `📉 <b>Price drop · now ${pct(ev.discount)} below market</b>` : `${icon} <b>${pct(ev.discount)} below market</b>`;
  const flags = (l.flags || []).filter((f) => f !== 'no_area');
  const verdict = { strong: '🟢 Looks clean', check: '🟡 Check first', skip: '🔴 Likely a catch' }[a.review?.verdict];
  return [
    `${head} · score <b>${ev.score}</b>/100`,
    `<b>${esc(l.title || 'Listing')}</b>`,
    `💶 <b>${esc(formatMoney(l.price, l.currency))}</b>${l.deal_type === 'rent' ? '/month' : ''} · ${esc(formatArea(l.area_m2, areaUnit))} · ${roomsLabel(l.rooms)}`,
    ev.metric === 'm2'
      ? `📊 ${esc(formatPerArea(l.price_m2, l.currency, areaUnit))} vs market ${esc(formatPerArea(ev.market, l.currency, areaUnit))}`
      : `📊 vs typical ${esc(formatMoney(ev.market, l.currency))}`,
    `💰 Est. value ${esc(formatMoney(ev.estimatedValue, l.currency))} → <b>${esc(formatMoney(ev.savings, l.currency))}</b> below`,
    a.prevPrice ? `📉 Was ${esc(formatMoney(a.prevPrice, l.currency))}` : null,
    `📍 ${esc([l.district, l.city].filter(Boolean).join(', '))} · <i>${esc(ev.segment)}, ${ev.comps} comps, confidence ${pct(ev.confidence)}</i>`,
    flags.length ? `⚠️ ${esc(flags.map(flagLabel).join(', '))}` : null,
    a.review?.summary ? `${verdict ? `${verdict}: ` : ''}${esc(a.review.summary)}` : null,
    a.review?.checks?.length ? `☑️ ${esc(a.review.checks.join(' · '))}` : null,
    `<i>${esc(l.source)}</i>`,
  ].filter(Boolean).join('\n');
}

export function formatSummaryText(s) {
  const lines = [`Scan finished in ${Math.round(s.ms / 1000)} s: ${s.listings} listings (${s.newListings} new) from ${s.sourcesOk}/${s.sources} sources, ${s.deals} deal(s), ${s.alerts} alert(s).`];
  for (const f of s.failures || []) lines.push(`✖ ${f.source}: ${f.error}`);
  if (s.suspicious) lines.push(`${s.suspicious} suspiciously cheap listing(s) held back (see report).`);
  if (s.unrated) lines.push(`${s.unrated} listing(s) not rated yet (not enough comparables).`);
  return lines.join('\n');
}

/** Does this subscriber want this deal? */
export function subscriberWants(sub, a) {
  if (sub.min_discount != null && (a.ev.discount || 0) < sub.min_discount) return false;
  if (sub.max_price && a.listing.price > sub.max_price) return false;
  if (sub.cities) {
    const want = sub.cities.split(',').map((c) => normText(c)).filter(Boolean);
    if (want.length && !want.includes(normText(a.listing.city))) return false;
  }
  return true;
}

export function createChannels(env = process.env, { store, fetchImpl = fetch, quiet = false, log = console.log, settings = {} } = {}) {
  const channels = [];
  const fmt = { areaUnit: settings.areaUnit || 'm2' };

  if (!quiet) {
    channels.push({
      name: 'console',
      send: async (a) => log(`\n🔔 ${formatDealText(a, fmt).replace(/\n/g, '\n   ')}`),
      summary: async (s) => log(`\n${formatSummaryText(s)}`),
    });
  }

  const tg = createTelegram(env.TELEGRAM_BOT_TOKEN, { fetchImpl });
  if (tg) {
    const fixed = String(env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
    const recipients = (a) => {
      const subs = (store?.subscribers() || []).filter((s) => !fixed.includes(s.chat_id) && (!a || subscriberWants(s, a)));
      return [...fixed, ...subs.map((s) => s.chat_id)];
    };
    const sendDeal = async (chat, a) => {
      const html = formatDealHtml(a, fmt);
      const markup = { reply_markup: { inline_keyboard: [[{ text: 'Open listing', url: a.listing.url }]] } };
      if (a.listing.image && html.length <= 1024 && env.TELEGRAM_PHOTOS !== 'false') {
        try { return await tg.sendPhoto(chat, a.listing.image, html, markup); } catch { /* image blocked or invalid: text instead */ }
      }
      return tg.sendMessage(chat, html, markup);
    };
    channels.push({
      name: 'telegram',
      recipients,
      async send(a) {
        const to = recipients(a);
        if (!to.length) return;
        const errors = [];
        for (const chat of to) {
          try { await sendDeal(chat, a); } catch (err) {
            errors.push(`${chat}: ${err.message}`);
            if (err.code === 403) store?.unsubscribe(chat); // user blocked the bot
          }
        }
        if (errors.length === to.length) throw new Error(errors.join('; '));
      },
      async summary(s) {
        if (env.TELEGRAM_SUMMARY === 'false' || (!s.alerts && !s.failures?.length && env.TELEGRAM_SUMMARY !== 'always')) return;
        for (const chat of fixed) await tg.sendMessage(chat, esc(formatSummaryText(s)));
      },
    });
  }

  if (env.SLACK_WEBHOOK_URL) {
    const post = (body) => fetchImpl(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      .then((r) => { if (!r.ok) throw new Error(`Slack HTTP ${r.status}`); });
    channels.push({
      name: 'slack',
      send: (a) => post({ text: formatDealText(a, fmt) }),
      summary: (s) => post({ text: formatSummaryText(s) }),
    });
  }

  if (env.ALERT_WEBHOOK_URL) {
    // Machine-readable payload for n8n / Make / Zapier / a CRM (HubSpot, Pipedrive) or a Google Sheet.
    const headers = { 'Content-Type': 'application/json', ...(env.ALERT_WEBHOOK_SECRET ? { 'X-Deal-Scanner-Secret': env.ALERT_WEBHOOK_SECRET } : {}) };
    const post = (body) => fetchImpl(env.ALERT_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      .then((r) => { if (!r.ok) throw new Error(`webhook HTTP ${r.status}`); });
    channels.push({
      name: 'webhook',
      send: (a) => post({
        event: a.type,
        listing: {
          id: a.listing.uid, url: a.listing.url, title: a.listing.title, source: a.listing.source, price: a.listing.price, currency: a.listing.currency,
          deal_type: a.listing.deal_type, area_m2: a.listing.area_m2, rooms: a.listing.rooms, property_type: a.listing.property_type,
          city: a.listing.city, district: a.listing.district, image: a.listing.image, flags: a.listing.flags, price_m2: a.listing.price_m2,
        },
        valuation: a.ev,
        review: a.review || null,
        previous_price: a.prevPrice || null,
        sent_at: new Date().toISOString(),
      }),
      summary: (s) => post({ event: 'scan_summary', ...s }),
    });
  }
  return channels;
}

/** Send to every channel; returns the names that succeeded. */
export async function dispatch(channels, kind, payload, { warn = console.warn } = {}) {
  const ok = [];
  await Promise.all(channels.map(async (c) => {
    try {
      await c[kind](payload);
      ok.push(c.name);
    } catch (err) {
      warn(`[notify] ${c.name} failed: ${err.message}`);
    }
  }));
  return ok;
}
