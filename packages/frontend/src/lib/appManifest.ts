import type { Manifest } from '@tinycloud/web-sdk';

/**
 * The Git Haiku owner-app manifest.
 *
 * Signed at OpenKey/web-sdk sign-in, this drives the SIWE recap. The `secrets`
 * field declares GITHUB_TOKEN; `resolveManifest` expands it to the concrete
 * `vault/secrets/GITHUB_TOKEN` KV-get/put path under the owner's `secrets`
 * space PLUS the owner's default encryption-network decrypt — exactly the
 * resources the owner must hold so that:
 *   1. `tcw.secrets.put('GITHUB_TOKEN', token)` writes the encrypted payload, and
 *   2. the backend's KV-get(vault/secrets/GITHUB_TOKEN)+decrypt delegation
 *      (composed in from `/api/server-info`) is a SUBSET of the owner's grant,
 *      so `materializeDelegation` mints it without a second wallet prompt.
 *
 * `defaults: true` pulls in the standard KV + encryption entries (matches
 * listen's manifest), so signing in grants the owner full control of their own
 * secrets space.
 */
export const APP_MANIFEST: Manifest = {
  manifest_version: 1,
  app_id: 'xyz.tinycloud.githaiku',
  name: 'Git Haiku',
  description: 'Verifiable haiku from your recent commit messages, generated inside an attested TEE.',
  defaults: true,
  secrets: {
    GITHUB_TOKEN: ['read'],
  },
  permissions: [],
};
