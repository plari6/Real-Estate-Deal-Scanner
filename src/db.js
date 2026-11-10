// SQLite store (built-in node:sqlite, WAL). The market average improves with every scan because
// listings stay as comparables for COMPS_WINDOW_DAYS after they were last seen.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,          -- source:portal-id (or URL path)
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  price REAL NOT NULL,
  currency TEXT,
  deal_type TEXT,                    -- sale | rent (rent = per month)
  area_m2 REAL,
  rooms REAL,
  property_type TEXT,
  city TEXT,
  district TEXT,
  address TEXT,
  image TEXT,
  description TEXT,
  price_text TEXT,
  price_m2 REAL,
  flags TEXT,                        -- JSON array of red flags
  fingerprint TEXT,                  -- same flat on several portals
  method TEXT,                       -- adapter that read it
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  prev_price REAL,
  price_changed_at TEXT,
  -- latest valuation
  deal_status TEXT,                  -- deal | suspicious | excluded | fair | unrated
  market REAL,                       -- market value per m² (metric m2) or per listing (metric price)
  metric TEXT,
  level TEXT,
  segment TEXT,
  comps INTEGER,
  discount REAL,
  estimated_value REAL,
  savings REAL,
  confidence REAL,
  score INTEGER,
  reasons TEXT,
  ai_review TEXT,                    -- JSON from the AI review
  evaluated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_seen ON listings(last_seen);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(deal_status, score);
CREATE TABLE IF NOT EXISTS price_history (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL,
  price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ph ON price_history(listing_id, seen_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER REFERENCES listings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                -- new_deal | price_drop
  price REAL,
  discount REAL,
  score INTEGER,
  channels TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_listing ON alerts(listing_id, created_at);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats TEXT
);
CREATE TABLE IF NOT EXISTS subscribers (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  min_discount REAL,                 -- personal threshold, e.g. 0.25
  cities TEXT,                       -- comma separated filter, empty = all
  max_price REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);
`;

const json = (v, d = null) => {
  if (v == null) return d;
  try { return JSON.parse(v); } catch { return d; }
};

export function rowToListing(r) {
  if (!r) return null;
  return { ...r, flags: json(r.flags, []), reasons: json(r.reasons, []), ai_review: json(r.ai_review) };
}

// node:sqlite cannot bind undefined.
const nul = (...args) => args.map((a) => (a === undefined ? null : a));

const daysAgo = (days, now = new Date()) => new Date(now.getTime() - days * 86400000).toISOString();

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Migrations for databases created by an older version.
  const cols = new Set(db.prepare('PRAGMA table_info(listings)').all().map((c) => c.name));
  for (const [c, t] of [['lat', 'REAL'], ['lng', 'REAL']]) if (!cols.has(c)) db.exec(`ALTER TABLE listings ADD COLUMN ${c} ${t}`);

  const q = {
    get: db.prepare('SELECT * FROM listings WHERE uid = ?'),
    byId: db.prepare('SELECT * FROM listings WHERE id = ?'),
    insert: db.prepare(`INSERT INTO listings (uid, source, url, title, price, currency, deal_type, area_m2, rooms, property_type, city, district,
      address, image, description, price_text, price_m2, flags, fingerprint, method, first_seen, last_seen, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE listings SET url = ?, title = COALESCE(?, title), price = ?, currency = ?, deal_type = ?, area_m2 = COALESCE(?, area_m2),
      rooms = COALESCE(?, rooms), property_type = ?, city = COALESCE(?, city), district = COALESCE(?, district), address = COALESCE(?, address),
      image = COALESCE(?, image), description = COALESCE(?, description), price_text = ?, price_m2 = ?, flags = ?, fingerprint = ?, method = ?,
      last_seen = ?, prev_price = ?, price_changed_at = ?, lat = COALESCE(?, lat), lng = COALESCE(?, lng) WHERE id = ?`),
    history: db.prepare('INSERT INTO price_history (listing_id, seen_at, price) VALUES (?, ?, ?)'),
    evaluation: db.prepare(`UPDATE listings SET deal_status = ?, market = ?, metric = ?, level = ?, segment = ?, comps = ?, discount = ?,
      estimated_value = ?, savings = ?, confidence = ?, score = ?, reasons = ?, evaluated_at = ? WHERE id = ?`),
  };

  return {
    db,
    close: () => db.close(),

    /** Insert or update a listing seen in a scan. Returns { listing, isNew, prevPrice }. */
    upsertListing(l, now = new Date().toISOString()) {
      const old = q.get.get(l.uid);
      const flags = JSON.stringify(l.flags || []);
      if (!old) {
        const r = q.insert.run(...nul(l.uid, l.source, l.url, l.title, l.price, l.currency, l.deal_type, l.area_m2, l.rooms, l.property_type, l.city, l.district,
          l.address, l.image, l.description, l.priceText, l.price_m2, flags, l.fingerprint, l.method, now, now, l.lat, l.lng));
        q.history.run(Number(r.lastInsertRowid), now, l.price);
        return { listing: rowToListing(q.byId.get(Number(r.lastInsertRowid))), isNew: true, prevPrice: null };
      }
      const changed = Math.abs(old.price - l.price) >= 1;
      const area = l.area_m2 ?? old.area_m2;
      const priceM2 = area ? Math.round((l.price / area) * 100) / 100 : null;
      // Keep flags the AI review added earlier.
      const mergedFlags = JSON.stringify([...new Set([...(l.flags || []).filter((f) => f !== 'no_area' || !area), ...json(old.flags, []).filter((f) => f !== 'no_area')])]);
      q.update.run(...nul(l.url, l.title, l.price, l.currency, l.deal_type, l.area_m2, l.rooms, l.property_type, l.city, l.district, l.address,
        l.image, l.description, l.priceText, priceM2, mergedFlags, l.fingerprint ?? old.fingerprint, l.method, now,
        changed ? old.price : old.prev_price, changed ? now : old.price_changed_at, l.lat, l.lng, old.id));
      if (changed) q.history.run(old.id, now, l.price);
      return { listing: rowToListing(q.byId.get(old.id)), isNew: false, prevPrice: changed ? old.price : null };
    },

    getListing: (idOrUid) => rowToListing(typeof idOrUid === 'number' || /^\d+$/.test(String(idOrUid)) ? q.byId.get(Number(idOrUid)) : q.get.get(idOrUid)),

    saveEvaluation(id, ev, now = new Date().toISOString()) {
      q.evaluation.run(ev.status, ev.market ?? null, ev.metric ?? null, ev.level ?? null, ev.segment ?? null, ev.comps ?? 0, ev.discount ?? null,
        ev.estimatedValue ?? null, ev.savings ?? null, ev.confidence ?? null, ev.score ?? 0, JSON.stringify(ev.reasons || []), now, id);
    },

    setFlags(id, flags) {
      db.prepare('UPDATE listings SET flags = ? WHERE id = ?').run(JSON.stringify(flags), id);
    },
    setDetails(id, { description, area_m2, flags }) {
      const old = q.byId.get(id);
      const area = old.area_m2 ?? area_m2 ?? null;
      db.prepare('UPDATE listings SET description = COALESCE(?, description), area_m2 = ?, price_m2 = ?, flags = ? WHERE id = ?')
        .run(description ?? null, area, area ? Math.round((old.price / area) * 100) / 100 : null, JSON.stringify(flags), id);
    },
    setAiReview(id, review) {
      db.prepare('UPDATE listings SET ai_review = ? WHERE id = ?').run(JSON.stringify(review), id);
    },

    /** Listings usable as comparables: seen within the window. */
    activeListings(windowDays = 90, now = new Date()) {
      return db.prepare('SELECT * FROM listings WHERE last_seen >= ?').all(daysAgo(windowDays, now)).map(rowToListing);
    },

    /** Deals for reports, the bot and the CLI. */
    deals({ status = ['deal'], city, minDiscount = 0, limit = 50, sinceDays = 14, source, now = new Date() } = {}) {
      const where = [`deal_status IN (${status.map(() => '?').join(',')})`, 'last_seen >= ?', 'COALESCE(discount, 0) >= ?'];
      const args = [...status, daysAgo(sinceDays, now), minDiscount];
      if (city) { where.push('LOWER(city) = LOWER(?)'); args.push(city); }
      if (source) { where.push('source = ?'); args.push(source); }
      return db.prepare(`SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY score DESC, discount DESC LIMIT ?`).all(...args, limit).map(rowToListing);
    },

    listings({ limit = 1000, sinceDays = 90, now = new Date() } = {}) {
      return db.prepare('SELECT * FROM listings WHERE last_seen >= ? ORDER BY COALESCE(discount, -9) DESC LIMIT ?').all(daysAgo(sinceDays, now), limit).map(rowToListing);
    },

    priceHistory: (id) => db.prepare('SELECT seen_at, price FROM price_history WHERE listing_id = ? ORDER BY seen_at').all(id),

    lastAlert: (listingId) => db.prepare('SELECT * FROM alerts WHERE listing_id = ? ORDER BY id DESC LIMIT 1').get(listingId) || null,
    addAlert(a, now = new Date().toISOString()) {
      db.prepare('INSERT INTO alerts (listing_id, type, price, discount, score, channels, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(a.listingId, a.type, a.price, a.discount, a.score, (a.channels || []).join(','), now);
    },
    alerts: (limit = 50) => db.prepare(`SELECT a.*, l.title, l.url, l.city, l.district FROM alerts a LEFT JOIN listings l ON l.id = a.listing_id ORDER BY a.id DESC LIMIT ?`).all(limit),

    startScan(now = new Date().toISOString()) {
      return Number(db.prepare('INSERT INTO scans (started_at) VALUES (?)').run(now).lastInsertRowid);
    },
    finishScan(id, stats, now = new Date().toISOString()) {
      db.prepare('UPDATE scans SET finished_at = ?, stats = ? WHERE id = ?').run(now, JSON.stringify(stats), id);
    },
    lastScan: () => {
      const r = db.prepare('SELECT * FROM scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
      return r ? { ...r, stats: json(r.stats, {}) } : null;
    },

    counts() {
      return db.prepare(`SELECT COUNT(*) AS listings, SUM(deal_status = 'deal') AS deals, SUM(deal_status = 'suspicious') AS suspicious,
        SUM(deal_status = 'unrated') AS unrated, COUNT(DISTINCT source) AS sources, COUNT(DISTINCT city) AS cities FROM listings`).get();
    },

    // Telegram subscribers
    subscribe(chatId, name, now = new Date().toISOString()) {
      db.prepare(`INSERT INTO subscribers (chat_id, name, created_at) VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET active = 1, name = COALESCE(excluded.name, name)`).run(String(chatId), name ?? null, now);
    },
    unsubscribe: (chatId) => db.prepare('UPDATE subscribers SET active = 0 WHERE chat_id = ?').run(String(chatId)),
    updateSubscriber(chatId, fields) {
      const allowed = ['min_discount', 'cities', 'max_price'];
      for (const [k, v] of Object.entries(fields)) if (allowed.includes(k)) db.prepare(`UPDATE subscribers SET ${k} = ? WHERE chat_id = ?`).run(v, String(chatId));
    },
    subscriber: (chatId) => db.prepare('SELECT * FROM subscribers WHERE chat_id = ?').get(String(chatId)) || null,
    subscribers: () => db.prepare('SELECT * FROM subscribers WHERE active = 1').all(),

    kvGet: (k) => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value ?? null,
    kvSet: (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v)),

    cacheGet: (k) => json(db.prepare('SELECT value FROM ai_cache WHERE key = ?').get(k)?.value),
    cacheSet: (k, v) => db.prepare('INSERT OR REPLACE INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)').run(k, JSON.stringify(v), new Date().toISOString()),
  };
}
