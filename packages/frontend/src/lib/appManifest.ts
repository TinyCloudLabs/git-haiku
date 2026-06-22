import type { Manifest } from '@tinycloud/web-sdk';

/**
 * The single secret scope namespacing this app's secrets. Canonical form (===
 * `canonicalizeSecretScope('githaiku')`), so it resolves to the scoped vault
 * path `vault/secrets/scoped/githaiku/GITHUB_TOKEN`. Frontend manifest
 * resolution + backend policy both key off this value so their paths match.
 */
export const GITHUB_TOKEN_SCOPE = 'githaiku';

/**
 * The Git Haiku owner-app manifest.
 *
 * Signed at OpenKey/web-sdk sign-in, this drives the SIWE recap. The `secrets`
 * field declares GITHUB_TOKEN under the `githaiku` scope; `resolveManifest`
 * expands it to the concrete `vault/secrets/scoped/githaiku/GITHUB_TOKEN` KV-get/
 * put path under the owner's `secrets` space PLUS the owner's default
 * encryption-network decrypt — exactly the resources the owner must hold so that:
 *   1. `tcw.secrets.put('GITHUB_TOKEN', token, { scope: GITHUB_TOKEN_SCOPE })`
 *      writes the encrypted payload, and
 *   2. the backend's KV-get(vault/secrets/scoped/githaiku/GITHUB_TOKEN)+decrypt
 *      delegation (composed in from `/api/server-info`) is a SUBSET of the
 *      owner's grant, so `materializeDelegation` mints it without a second
 *      wallet prompt.
 *
 * `defaults: true` pulls in the standard KV + encryption entries (matches
 * listen's manifest), so signing in grants the owner full control of their own
 * secrets space.
 */
export const APP_MANIFEST: Manifest = {
  manifest_version: 1,
  app_id: 'com.githaiku',
  name: 'Git Haiku',
  description: 'Verifiable haiku from your recent commit messages, generated inside an attested TEE.',
  defaults: true,
  secrets: {
    GITHUB_TOKEN: { actions: ['read', 'write'], scope: GITHUB_TOKEN_SCOPE },
  },
  permissions: [],
};
