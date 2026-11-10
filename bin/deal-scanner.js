#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on some Node versions; hide only that one.
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w?.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...a));

const { main } = await import('../src/cli.js');
main().catch((err) => {
  console.error(`✖ ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
