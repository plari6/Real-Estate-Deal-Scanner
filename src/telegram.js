// Tiny Telegram Bot API client (native fetch, no library). Handles 429 retry_after once.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramError extends Error {
  constructor(message, { code, retryAfter } = {}) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTelegram(token, { fetchImpl = fetch, timeoutMs = 15000, apiBase = 'https://api.telegram.org' } = {}) {
  if (!token) return null;
  async function call(method, payload = {}, { timeout = timeoutMs, retry = true } = {}) {
    const res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (body.ok) return body.result;
    const retryAfter = body.parameters?.retry_after;
    if (res.status === 429 && retry && retryAfter && retryAfter <= 30) {
      await sleep(retryAfter * 1000);
      return call(method, payload, { timeout, retry: false });
    }
    throw new TelegramError(`Telegram ${method}: ${body.description || res.status}`, { code: body.error_code || res.status, retryAfter });
  }
  return {
    call,
    getMe: () => call('getMe'),
    sendMessage: (chatId, text, extra = {}) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }),
    sendPhoto: (chatId, photo, caption, extra = {}) => call('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...extra }),
    getUpdates: (offset, timeout = 25) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeout: (timeout + 10) * 1000 }),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {}),
    setMyCommands: (commands) => call('setMyCommands', { commands }),
  };
}

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
