// The single loader for the per-build QA config. Every tool under qa/ reads the reference,
// the clone, the routes and the widths from here, so no target is named in a script.
//
//   never_to_be_pushed/discovery/seemly.config.json   (shape: templates/seemly.config.json)
//
// Environment overrides for one run: SEEMLY_CONFIG (path), ROUTES (comma list), CLONE (origin).
import { existsSync, readFileSync } from 'fs';

export const CONFIG_PATH = process.env.SEEMLY_CONFIG || 'never_to_be_pushed/discovery/seemly.config.json';

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`no QA config at ${CONFIG_PATH}; copy templates/seemly.config.json and fill it`);
  const c = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  for (const k of ['reference', 'clone', 'routes']) if (!c[k]) throw new Error(`QA config: missing "${k}"`);
  return {
    ...c,
    clone: { ...c.clone, origin: process.env.CLONE || c.clone.origin },
    routes: process.env.ROUTES ? process.env.ROUTES.split(',') : c.routes,
    widths: c.widths || [1024, 1280, 1440, 1680, 1920, 2560],
    cdp: c.cdp || 'http://127.0.0.1:9222',
  };
}
