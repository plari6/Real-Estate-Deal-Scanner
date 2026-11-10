# Real-Estate Deal Scanner

Scrapes real estate portals, values every listing against **similar homes nearby**, and sends a Telegram alert when a property is priced **20 % or more below the local market**, with the reasons, the red flags and a link.

**Stack:** JavaScript (Node.js 24, ESM) - a Puppeteer scraper plus a Telegram bot and a CLI; JavaScript ships fastest here with the fewest moving parts.

```
🔥 32% below market · score 78/100
Inheritance sale: 3-room apartment with balcony in Kreuzberg
💶 €359,000 · 82 m² · 3 rooms
📊 €4,378/m² vs market €6,472/m²
💰 Est. value €530,700 → €171,700 below
📍 Kreuzberg, Berlin · within 1.5 km · apartment, 12 comps, confidence 86%
🟢 Looks clean: sold by heirs, quick completion wanted; no catch in the text.
☑️ Confirm the living area · Ask why the seller prices below market
[ Open listing ]
```

## What it does

1. **Scrapes portal searches** (all pages): plain HTTP first, and **Puppeteer Stealth Chrome** automatically when a site blocks bots or renders with JavaScript. It respects robots.txt and waits between requests.
2. **Reads listings from any layout** with five adapters, choosing the best per page: schema.org JSON-LD, embedded app JSON (Next.js `__NEXT_DATA__`, Redux/Apollo state, `{key, value}` attribute lists), CSS selectors you configure, a zero-config card finder, and AI as a last resort with a hallucination guard.
3. **Normalizes** price, currency, m² (sq ft converted), rooms, type, sale vs rent, district, GPS and photo, in many formats: `€ 349.000`, `AED 1.2M`, `1,2 Mio. €`, `1 701 000 DH`, `£1,500 pcm`, `915 sq ft`, `3 Zimmer`, `2 pièces`, `3 غرف`.
4. **Values each listing** against the local market price per m² (details in "How the valuation works" below).
5. **Filters out false bargains** with multilingual red flags: auction / foreclosure, partial share, "price from" projects, rent-to-own, tenanted, renovation, leasehold, off-plan. Prices more than 55 % below market are held back as likely data errors.
6. **Reviews each deal**. It opens the listing page for the description, then an AI review (multi-model fallback chain, keyword rules if no model answers) writes a one-line verdict and things to check.
7. **Alerts** on Telegram (photo, deal card, "Open listing" button), Slack, or a JSON webhook for n8n, Make, Zapier, a CRM or Google Sheets. Each deal is alerted once, and again only when its price drops a further 3 %.
8. **Telegram bot**: `/deals`, `/top`, `/market`, personal `/threshold`, `/cities`, `/maxprice`, `/status`, `/scan`.
9. **Reports**: Excel (Deals / To check / All listings / Market, with clickable links), an HTML page for clients, CSV and JSON.
10. **Stores** everything in SQLite (`node:sqlite`, no native build), including price history. The market model gets better with every scan.

## Quick start

```bash
npm install
npm install-scripts approve puppeteer && npm rebuild puppeteer   # npm 11 blocks Puppeteer's Chrome download otherwise
node bin/deal-scanner.js demo                 # offline: 3 fake portals, 2 days, report in data/demo-report.*
node bin/deal-scanner.js demo --browser       # the same through real headless Chrome
npm test                                      # 46 tests, no network or keys needed
```

The demo runs three portals in three page formats, with 108 listings, planted bargains and planted traps. It finds the 4 real bargains and flags the renovation case. It holds back the 80 %-off data error, the auction, the "price from" project and the rent listing. On day 2 it sends one price-drop alert and one new deal, with no repeats.

## Set up for a client

```bash
node bin/deal-scanner.js init                         # creates sources.json and .env
# 1. sources.json: one entry per portal search (city + filters), see "Sources" below
# 2. .env: TELEGRAM_BOT_TOKEN from @BotFather; send /start to the bot, it replies with the chat id -> TELEGRAM_CHAT_ID
node bin/deal-scanner.js test-source rightmove-london  # what each adapter finds on page 1 (run for every new portal)
node bin/deal-scanner.js scan --dry-run               # full scan, prints the deals, sends nothing
node bin/deal-scanner.js notify-test                  # sample alert to Telegram / Slack / webhook
node bin/deal-scanner.js start --run-now              # scheduler (SCAN_CRON, default every 3 h) + Telegram bot + /health
node bin/deal-scanner.js doctor --ping                # config, Chrome, Telegram, and every AI model
```

Other commands: `deals [--city X] [--min 25] [--all]`, `market [--city X]`, `report [--format xlsx,html,csv,json]`, `import <file.csv|json|jsonl>` (Apify datasets, portal or MLS exports), `revalue` (after changing rules), `alerts`, `sources`, `bot`. Global flags: `--db`, `--sources`, `--threshold 25`, `--simulate-outage gemini`.

**Warm-up:** a fresh database knows nothing about the market, so the first scans leave many listings "unrated". Scan more pages, or one search per district, and run it for a few days. Listings stay comparables for 90 days (`COMPS_WINDOW_DAYS`).

## Sources (`sources.json`)

```json
{
  "defaults": { "dealType": "sale" },
  "sources": [
    { "name": "rightmove-london", "url": "https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION%5E87490&index={offset}",
      "pageSize": 24, "pages": 5, "defaults": { "city": "London", "currency": "GBP", "areaUnit": "sqft" } },
    { "name": "avito-casablanca", "url": "https://www.avito.ma/fr/casablanca/appartements-%C3%A0_vendre?o={page}",
      "pages": 5, "defaults": { "city": "Casablanca", "currency": "MAD", "type": "apartment" } },
    { "name": "my-portal", "url": "https://portal.example/search?city=berlin&page={page}", "pages": 3, "engine": "browser", "scrolls": 2,
      "selectors": { "card": "article.listing", "title": "h2", "price": ".price", "area": ".facts li:nth-child(1)",
                     "rooms": ".facts li:nth-child(2)", "location": ".address", "link": "a@href", "image": "img@data-src || img@src" },
      "defaults": { "city": "Berlin", "currency": "EUR" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `url` | Search page. `{page}` = 1, 2, 3…; `{offset}` = (page − 1) × `pageSize`; otherwise `pageParam` (default `page`) is added for page 2+. |
| `pages` | Pages per scan. It stops early when a page is empty or repeats the previous one. |
| `engine` | `auto` (HTTP, Chrome when needed, remembered per source), `http` or `browser`. |
| `adapter` | `auto` or force one of `jsonld`, `embedded`, `css`, `cards`, `ai`. |
| `selectors` | For `css`: `card`, `title`, `price`, `area`, `rooms`, `bedrooms`, `location`, `district`, `city`, `link`, `image`, `lat`, `lng`. `css@attr` reads an attribute, and `a || b` is a fallback. |
| `fieldMap` | For `embedded`: `{ "list": "props.pageProps.results", "price": "price.value", "area": "size.value", "lat": "geo.lat", "lng": "geo.lng" }`. |
| `urlTemplate` | `https://portal/property/{id}` when the JSON has ids but no links. |
| `scrolls`, `waitForSelector` | For infinite-scroll pages in the browser. |
| `defaults` | `city`, `district`, `currency`, `type`, `dealType`, `areaUnit` (`m2` or `sqft`) used when the page does not say. |
| `enabled` | `false` to skip a source. |

### Portals tested live (November 2026)

| Portal | Result |
|---|---|
| Rightmove (UK) | HTTP, embedded JSON: price, bedrooms, sq ft, GPS, postcode district. 25 per page. |
| Daft.ie (Ireland) | HTTP, embedded JSON: price, m², beds, GPS, Dublin postal district. 20 per page. |
| Avito.ma (Morocco) | HTTP 403, so Puppeteer Stealth takes over automatically. Embedded JSON attribute lists: price, m², rooms, district. About 44 per page. |
| Mubawab.ma (Morocco) | Zero-config card finder, 31 per page. robots.txt allows page 1 only, which the scanner respects. |
| PropertyFinder (UAE) | Blocked by robots.txt, so the scanner refuses (`RESPECT_ROBOTS=false` only with the site's permission). |

Portals change often. Run `test-source` when a source starts returning 0, and pin `selectors` or `fieldMap` if needed. For strict portals (Zillow, Idealista, ImmoScout24, Bayut), use a residential `PROXY_URL`, a slower schedule, an official API or feed, or `import` an Apify dataset.

## How the valuation works

For each listing, the scanner tries these groups of comparables from the most specific to the broadest. It uses the first group with at least `MIN_COMPS` listings whose prices are not too mixed:

| Level | Comparables |
|---|---|
| nearby + rooms | GPS within 1.5 km (`GEO_RADIUS_KM`), same type, same room band |
| nearby | within 1.5 km, same type |
| district + rooms / district | same district (portal field, address, UK/IE postcode, or title "… à Californie") |
| nearby-wide | within 3 km |
| city + rooms / city | only when no listing in the city has a location (for example one small town) |

Every group follows these rules:

- **Like with like:** sale vs sale and rent vs rent (per month), same currency, same property type.
- **Similar size:** 0.4×–1.6× the living area, because price per m² falls as homes get bigger.
- **Each flat counts once:** the listing itself is left out of its own average, and the same flat listed on two portals counts once.
- **No distorted prices:** auctions, shares and "price from" listings are never used as comparables.
- **Spread guard (`MAX_SPREAD` 0.4):** a group whose middle 50 % of prices spans more than 40 % of the median has no meaningful average. A London-wide or Dublin-wide average is a good example, since it mixes cheap and expensive areas. Such groups are skipped.
- **Location rule (`LOCAL_ONLY`):** a listing whose location is known is never compared with a city-wide average. A listing with no location, in a city where others have one, is left unrated.

`discount = 1 − price per m² ÷ market median`. It is a **deal** at `DEAL_THRESHOLD` (20 %). It is **suspicious** from `SUSPICIOUS_THRESHOLD` (55 %) and held back. It is **excluded** with an `EXCLUDE_FLAGS` flag. Listings without an area are compared on total price within the same room band. The **score (0–100)** combines how deep the discount is (up to 40 %), confidence (group level, number of comps, spread, m² vs total price), red-flag penalties and the AI verdict.

Results from the live check: comparing London listings with a London-wide average marked 46 of 145 listings as "deals". That's noise, because outer boroughs are simply cheaper. With GPS comps, size matching and the spread guard, the same kind of data gives about 6 % deals, each compared with similar homes within 1.5–3 km.

## Telegram

- `TELEGRAM_CHAT_ID` chats get every deal and the scan summary, and are admins (they can use `/scan`).
- The bot is private by default. A stranger who sends `/start` gets their chat id back, and you add it to `TELEGRAM_ALLOWED_CHATS` (for clients or team members). `BOT_OPEN=true` lets anyone subscribe.
- Subscribers set their own filters: `/threshold 25`, `/cities Casablanca,Rabat`, `/maxprice 1.500.000`.
- `/deals [city]`, `/top`, `/market [city]`, `/status`, `/stop`, `/help`. The bot uses long polling, so it needs no public URL.

## AI (optional)

AI runs through the `src/ai` multi-model router (Gemini versions → Gemma → Groq → NVIDIA → OpenRouter free → Ollama), with timeouts, cooldowns and hedging. Set any of `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, `OPENROUTER_API_KEY`. It is used for:

- reading pages where no other adapter finds listings (a listing is kept only if its link is on the page and its price digits appear in the page text)
- reviewing deals (verdict, hidden catches as flags, things to check), capped by `AI_REVIEW_MAX` per scan and cached

Without keys, or when every model is down, keyword rules do the review and the scanner keeps working. For paying clients, use a paid Gemini key first in the chain, because free-tier prompts may be used for training.

## Deploy

```bash
cp examples/sources.example.json data/sources.json   # edit
docker compose up -d --build                         # system Chromium, shm 512 MB, /health on :8080
docker compose run --rm deal-scanner test-source avito-casablanca
```

Without Docker: `npm ci && node bin/deal-scanner.js start --run-now` under pm2, systemd or a Windows scheduled task. `GET /health` returns the last scan, counts and the AI model status.

## Use from code

```js
import { openDb, getSettings, loadSources, runScan, createChannels, writeReports } from 'real-estate-deal-scanner';
const settings = getSettings();
const store = openDb(settings.dbPath);
const summary = await runScan({ store, sources: loadSources(settings.sourcesPath), settings, channels: createChannels(process.env, { store, settings }) });
await writeReports(store, { formats: ['xlsx'] });
```

## Project layout

```
bin/deal-scanner.js      CLI entry
src/cli.js               commands
src/scanner.js           scan pipeline (pages -> listings -> valuation -> enrich -> alerts)
src/fetcher.js           robots.txt, HTTP, Puppeteer fallback, bot-wall detection, politeness
src/fetch/               http, robots, stealth browser pool
src/adapters/            jsonld, embedded (app JSON), css + card finder, ai, auto picker
src/normalize.js         raw -> listing (price, m², rooms, district, GPS, uid, fingerprint)
src/parse.js             multilingual price / area / rooms / type parsing
src/market.js            comparables, spread guard, discount, confidence, score
src/flags.js             red flags (EN/DE/FR/ES/IT/NL/AR)
src/enrich.js            detail pages + AI / keyword deal review
src/notify.js            Telegram, Slack, webhook, console
src/bot.js               Telegram bot commands
src/db.js                SQLite store
src/report.js            Excel / HTML / CSV / JSON
src/importer.js          CSV / JSON / JSONL import
src/demo.js              offline fake portals
src/ai/                  multi-model fallback router
```

## Responsible use

Scrape only what a portal's terms and robots.txt allow, at a polite rate (the defaults: robots.txt on, 2.5 s between requests to a site, sequential pages). Keep the data for your own analysis. Prefer official APIs or data feeds where they exist. Listings and the valuation are signals, not appraisals: always verify the area, condition and legal status before an offer.

## License

MIT
