/**
 * Frontend runtime configuration.
 *
 * The backend base URL is CONFIGURABLE, never hardcoded:
 *  - dev (default): the portless backend is reverse-proxied by Vite at the same
 *    origin under `/api`, `/health`, `/attestation` (see vite.config.ts). So the
 *    default base is the empty string → same-origin relative fetches that the
 *    dev proxy forwards to https://api.githaiku.localhost.
 *  - prod: set VITE_BACKEND_URL (e.g. https://api.githaiku.com). A non-empty
 *    value makes the client target that absolute origin directly.
 *
 * OPENKEY_HOST is likewise overridable for self-hosted OpenKey instances.
 */

/** Absolute backend origin, or '' to use the same-origin Vite dev proxy. */
export const BACKEND_URL: string = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '');

/** OpenKey instance the owner authenticates against. */
export const OPENKEY_HOST: string = import.meta.env.VITE_OPENKEY_HOST ?? 'https://openkey.so';

/**
 * The TinyCloud node host(s) for the owner's web-sdk session.
 *
 * OPTIONAL — only set when `VITE_TINYCLOUD_HOST` is provided as an explicit
 * override (self-hosted/staging nodes). Otherwise left `undefined` so the
 * web-sdk resolves the node itself (registry lookup → `node.tinycloud.xyz`
 * fallback). As of web-sdk 2.4.0-beta.11, restored sessions rehydrate their
 * `tinycloudHosts` too, so no hardcoded host is needed to make a restored
 * session usable for secrets/space/encryption calls. Mirrors listen.
 */
const TINYCLOUD_HOST = import.meta.env.VITE_TINYCLOUD_HOST as string | undefined;
export const TINYCLOUD_HOSTS: string[] | undefined = TINYCLOUD_HOST ? [TINYCLOUD_HOST] : undefined;

/** App display name shown in the OpenKey passkey prompt. */
export const APP_NAME = 'Git Haiku';

/** Build an absolute backend URL for a given path (works in dev + prod). */
export function backendUrl(path: string): string {
  return `${BACKEND_URL}${path}`;
}
