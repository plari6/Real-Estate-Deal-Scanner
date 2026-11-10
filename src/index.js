// Library entry point: use the scanner from your own code (Express API, n8n custom node, cron job).
export { getSettings, loadSources, loadEnv, pageUrl } from './config.js';
export { openDb } from './db.js';
export { runScan, scanSource, revalueAll } from './scanner.js';
export { extractListings } from './adapters/index.js';
export { normalizeListing } from './normalize.js';
export { evaluateListing, buildIndex, marketSummary, stats } from './market.js';
export { createChannels, dispatch, formatDealText, formatDealHtml } from './notify.js';
export { createBot } from './bot.js';
export { writeReports } from './report.js';
export { importFile } from './importer.js';
export { createFetcher } from './fetcher.js';
export { parsePrice, parseArea, parseRooms } from './parse.js';
export { detectFlags, FLAGS } from './flags.js';
