/**
 * Backend configuration + dev-mode flags.
 *
 * The preview runs entirely in dev mode with explicit, labeled fallbacks. The
 * real trust-contract pieces (TinyCloud delegated secrets, dstack TEE
 * attestation, Anthropic generation) sit behind these flags and are OFF by
 * default so the preview needs no external infra.
 */

function flag(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

export const config = {
  port: Number(process.env['PORT'] ?? 8787),
  host: process.env['HOST'] ?? '127.0.0.1',

  /** Where the dev-local owner store persists (gitignored). */
  dataDir: process.env['GITHAIKU_DATA_DIR'] ?? '.githaiku-dev',

  /**
   * Secrets provider:
   *  - 'local' (default): owner's tokens come from the dev-local store. No infra.
   *  - 'tc-cli': DEFERRED. Read the owner's secret under a TinyCloud delegation
   *    via `@tinycloud/cli`. Not wired for the preview; selecting it throws.
   */
  secretsProvider: (process.env['GITHAIKU_SECRETS_PROVIDER'] ?? 'local') as 'local' | 'tc-cli',

  /**
   * Haiku generator:
   *  - deterministic (default): template generator, NO Anthropic key needed.
   *  - anthropic: DEFERRED behind this flag. Uses the owner's Anthropic key.
   */
  useAnthropic: flag('GITHAIKU_USE_ANTHROPIC', false),

  /** GitHub fetch bounds (commit-messages-only; hard caps). */
  github: {
    maxCommits: Number(process.env['GITHAIKU_MAX_COMMITS'] ?? 30),
    windowDays: Number(process.env['GITHAIKU_WINDOW_DAYS'] ?? 30),
  },
} as const;

export type AppConfig = typeof config;
