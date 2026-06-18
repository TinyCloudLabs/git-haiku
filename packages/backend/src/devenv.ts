import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DEV-ONLY env loader.
 *
 * Loads KEY=value lines from `.githaiku-dev/dev.env` into process.env IF the
 * file exists, so the portless preview can pick up the backend-global RedPill
 * key/model without exporting them by hand. `.githaiku-dev/` is gitignored.
 *
 * Guards:
 *  - NEVER runs when NODE_ENV=production or GITHAIKU_TEE=1 (no dev secrets in
 *    production / the TEE — those get their config from the real environment).
 *  - Never OVERRIDES an already-set process.env value, so an explicit export
 *    (or the production environment) always wins.
 *  - Never logs the values it loads.
 *
 * This must run BEFORE config.ts reads process.env.
 */
export function loadDevEnv(): void {
  if (process.env['NODE_ENV'] === 'production') return;
  if (process.env['GITHAIKU_TEE'] === '1') return;

  const dataDir = process.env['GITHAIKU_DATA_DIR'] ?? '.githaiku-dev';
  const path = join(dataDir, 'dev.env');
  if (!existsSync(path)) return;

  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    // Don't override values already present in the environment.
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
