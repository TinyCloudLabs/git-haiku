/**
 * Backend configuration + dev-mode flags.
 *
 * The preview runs entirely in dev mode with explicit, labeled fallbacks. The
 * real trust-contract pieces (TinyCloud delegated secrets, dstack TEE
 * attestation) sit behind these flags and are OFF by default so the preview
 * needs no external infra.
 *
 * Haiku generation defaults to RedPill (Phala's confidential LLM gateway) when
 * REDPILL_API_KEY is present, and to the deterministic template otherwise — so
 * the zero-secret portless preview still renders a haiku.
 */
import { loadDevEnv } from './devenv';

// DEV-ONLY: pull .githaiku-dev/dev.env into process.env BEFORE we read it.
// No-op in production / the TEE. Must run before the config object is built.
loadDevEnv();

/** Which haiku generator to use. Default = redpill if a key is set, else deterministic. */
function resolveHaikuGenerator(): 'redpill' | 'deterministic' {
  const forced = process.env['GITHAIKU_HAIKU_GENERATOR'];
  if (forced === 'redpill' || forced === 'deterministic') return forced;
  return process.env['REDPILL_API_KEY'] ? 'redpill' : 'deterministic';
}

function parseAllowedOrigins(): string[] {
  const raw = process.env['GITHAIKU_ALLOWED_ORIGINS'];
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
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
   * Backend stable identity (tc-cli provider only). The owner delegates KV-get +
   * decrypt to THIS key's did:pkh; the backend reads secrets under that
   * delegation. From env/config for local dev; dstack-derived in the TEE (seam).
   */
  backendPrivateKey: process.env['GITHAIKU_BACKEND_PRIVATE_KEY'] ?? null,

  /** TinyCloud node host for the backend identity + delegated reads. */
  nodeHost: process.env['GITHAIKU_NODE_HOST'] ?? 'https://node.tinycloud.xyz',

  /**
   * The backend's public base URL (e.g. https://api.githaiku.com). Used to bind
   * the haiku proof's `attestation_url` to this app's `/attestation` endpoint.
   * Only set in a real deployment; null in dev (placeholder proof).
   */
  publicUrl: process.env['GITHAIKU_PUBLIC_URL'] ?? null,

  /**
   * Browser origins allowed to call this backend. Empty means permissive only
   * in local dev/test; production/TEE startup requires explicit origins.
   */
  allowedOrigins: parseAllowedOrigins(),

  /**
   * Haiku generator selection:
   *  - 'redpill': RedPill confidential-LLM-backed generator (the real path).
   *    Default whenever REDPILL_API_KEY is set.
   *  - 'deterministic': template generator, NO LLM key needed. Default when no
   *    key is present, so the portless preview works with zero secrets.
   * Force one explicitly via GITHAIKU_HAIKU_GENERATOR=redpill|deterministic.
   */
  haikuGenerator: resolveHaikuGenerator(),

  /**
   * RedPill (Phala confidential LLM gateway). Backend-GLOBAL service capability,
   * NOT a per-owner secret. Key comes from env (REDPILL_API_KEY), never from the
   * owner's delegated TinyCloud secrets.
   */
  redpill: {
    baseUrl: process.env['REDPILL_BASE_URL'] ?? 'https://api.redpill.ai/v1',
    // phala/ namespace = TEE-attestable, ECDSA-signed tier-1 inference.
    model: process.env['REDPILL_MODEL'] ?? 'phala/deepseek-v4-flash',
    apiKey: process.env['REDPILL_API_KEY'] ?? null,
    timeoutMs: Number(process.env['REDPILL_TIMEOUT_MS'] ?? 20000),
  },

  /** GitHub fetch bounds (commit-messages-only; hard caps). */
  github: {
    maxCommits: Number(process.env['GITHAIKU_MAX_COMMITS'] ?? 30),
    windowDays: Number(process.env['GITHAIKU_WINDOW_DAYS'] ?? 30),
  },
} as const;

export type AppConfig = typeof config;
