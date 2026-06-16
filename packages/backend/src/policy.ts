/**
 * Backend permission policy.
 *
 * The backend advertises exactly the permissions an owner must delegate so the
 * backend can read the owner's two secrets from TinyCloud Secrets:
 *  - per-secret KV `get` on `vault/secrets/<NAME>` in the owner's `secrets`
 *    space (skipPrefix: true), and
 *  - `decrypt` on the owner's default encryption network.
 *
 * Shapes lifted from listen `backend/src/manifest.ts` + `routes/server-info.ts`.
 * Kept deliberately minimal — a hand-built array, no manifest resolution.
 */

/** The two secrets the backend reads under delegation. */
export const SECRET_NAMES = ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export interface PermissionEntry {
  service: string;
  space?: string;
  path: string;
  actions: string[];
  skipPrefix?: boolean;
  description?: string;
}

/** The owner's secret lives at this KV path in their `secrets` space. */
export function secretVaultPath(name: SecretName): string {
  return `vault/secrets/${name}`;
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
