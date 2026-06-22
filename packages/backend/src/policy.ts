/**
 * Backend permission policy.
 *
 * The backend advertises exactly the permissions an owner must delegate so the
 * backend can read the owner's secret(s) from TinyCloud Secrets:
 *  - per-secret KV `get` on the SCOPED vault path
 *    `vault/secrets/scoped/githaiku/<NAME>` in the owner's `secrets` space
 *    (skipPrefix: true), derived via the SDK's `resolveSecretPath` so it
 *    provably matches the frontend manifest resolution, and
 *  - `decrypt` on the owner's default encryption network.
 *
 * The owner delegates exactly ONE secret: GITHUB_TOKEN (their private data). The
 * RedPill LLM key is backend-global config (env REDPILL_API_KEY), NOT an owner
 * secret, so it is deliberately absent here.
 *
 * Shapes lifted from listen `backend/src/manifest.ts` + `routes/server-info.ts`.
 * Kept deliberately minimal — a hand-built array, no manifest resolution.
 */

import { resolveSecretPath } from '@tinycloud/node-sdk';

/** The secret(s) the backend reads under delegation. GITHUB_TOKEN only. */
export const SECRET_NAMES = ['GITHUB_TOKEN'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * The single secret scope namespacing this app's secrets. Canonical (===
 * `canonicalizeSecretScope('githaiku')`). Shared by the KV-get path the backend
 * advertises AND the `tc secrets get --scope` read, and matches the frontend
 * manifest's `secrets.GITHUB_TOKEN.scope`.
 */
export const GITHUB_TOKEN_SCOPE = 'githaiku';

export interface PermissionEntry {
  service: string;
  space?: string;
  path: string;
  actions: string[];
  skipPrefix?: boolean;
  description?: string;
}

/**
 * The owner's secret lives at this SCOPED vault path in their `secrets` space.
 * Derived via the SDK so it matches the frontend manifest resolution exactly:
 * `vault/secrets/scoped/githaiku/<NAME>`.
 */
export function secretVaultPath(name: SecretName): string {
  return resolveSecretPath(name, { scope: GITHUB_TOKEN_SCOPE }).permissionPaths.vault;
}

/** did:pkh for an owner Ethereum address (mainnet by default). */
export function ownerDidFromAddress(address: string, chainId = 1): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}

/** The owner's default encryption network resource id. */
export function defaultEncryptionNetworkId(ownerDid: string): string {
  return `urn:tinycloud:encryption:${ownerDid}:default`;
}

/** Per-secret KV-get permission entries (no owner needed). */
function secretKvPermissions(): PermissionEntry[] {
  return SECRET_NAMES.map((name) => ({
    service: 'tinycloud.kv',
    space: 'secrets',
    path: secretVaultPath(name),
    actions: ['get'],
    skipPrefix: true,
    description: `Read the encrypted ${name} payload under the owner's delegation.`,
  }));
}

/** The decrypt entry for an owner's default encryption network. */
function encryptionPermission(ownerDid: string): PermissionEntry {
  return {
    service: 'tinycloud.encryption',
    space: 'encryption',
    path: defaultEncryptionNetworkId(ownerDid),
    actions: ['decrypt'],
    skipPrefix: true,
    description: "Decrypt Git Haiku secrets via the owner's default encryption network.",
  };
}

/**
 * The full policy the backend needs from a specific owner.
 *
 * When `ownerDid` is omitted (the /api/server-info advertisement, which is
 * owner-agnostic), the decrypt entry is templated against `<ownerDid>` so the
 * frontend/owner fills in their own DID at grant time.
 */
export function backendPolicy(ownerDid?: string): PermissionEntry[] {
  return [...secretKvPermissions(), encryptionPermission(ownerDid ?? '<ownerDid>')];
}
