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
 * MUST always be set. The web-sdk's `signIn()` first attempts an internal
 * `restoreSession()` from BrowserSessionStorage and, when a persisted session
 * exists, returns it WITHOUT running the wallet sign-in flow that resolves hosts
 * via the registry (`resolveTinyCloudHostsForSignIn`). On that restore path the
 * node's `tinycloudHosts` is left empty, so the first post-sign-in service call
 * (`ensureOwnedSpaceHosted('secrets')`) throws "TinyCloud hosts have not been
 * resolved. Call signIn() first." Passing `tinycloudHosts` at construction makes
 * `requireTinyCloudHosts()` satisfied on BOTH the fresh-sign-in and the internal
 * restore paths, so secrets/space/encryption calls work regardless of whether
 * the SDK signed in fresh or restored.
 *
 * Defaults to the public TinyCloud node (matching the backend's
 * `GITHAIKU_NODE_HOST` default); override with `VITE_TINYCLOUD_HOST` for
 * self-hosted/staging nodes.
 */
const TINYCLOUD_HOST = import.meta.env.VITE_TINYCLOUD_HOST as string | undefined;
export const TINYCLOUD_HOSTS: string[] = [TINYCLOUD_HOST ?? 'https://node.tinycloud.xyz'];

/** App display name shown in the OpenKey passkey prompt. */
export const APP_NAME = 'Git Haiku';

/** Build an absolute backend URL for a given path (works in dev + prod). */
export function backendUrl(path: string): string {
  return `${BACKEND_URL}${path}`;
}
