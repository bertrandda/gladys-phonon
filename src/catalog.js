// The voice catalog pinned by scripts/sync-voices.mjs (read once at startup;
// a JSON import would need an import attribute that is still experimental in
// some Node 22 releases).
import { readFileSync } from 'node:fs';

export const catalog = JSON.parse(
  readFileSync(new URL('./voices.catalog.json', import.meta.url), 'utf8'),
);
