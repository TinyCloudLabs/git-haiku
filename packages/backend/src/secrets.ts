import {
  deserializeDelegation,
  resolveSecretPath,
  type InlineEncryptedEnvelope,
  type PortableDelegation,
  type TinyCloudNode,
} from '@tinycloud/node-sdk';

import { config } from './config';
import { loadDelegation } from './delegation-store';
import { getBackendIdentity } from './identity';
import { GITHUB_TOKEN_SCOPE, SECRET_NAMES, type SecretName } from './policy';
import type { OwnerRecord } from './store';

/**
 * Secrets boundary.
 *
 * - LOCAL (default): the owner's GitHub token comes straight from the gitignored
 *   dev store. No TinyCloud node needed.
 * - SDK: the real trust contract. The owner's GITHUB_TOKEN lives in TinyCloud
 *   Secrets; the backend reads it under the owner's stored delegation directly
 *   via the node-SDK — the SAME mechanism the `listen` app uses on its server
 *   (`backend/src/delegation-activation.ts` + `services/source-secret.ts`). The
 *   backend applies the owner's serialized delegation through `useDelegation`,
 *   does a KV `get` on the owner's scoped secret path, and decrypts the inline
 *   envelope through the owner's encryption network. Secrets stay in memory —
 *   never written to disk, never logged.
 *
 * The RedPill LLM key is backend-global config (env), NOT an owner secret, so it
 * is not part of this boundary.
 */
export interface OwnerSecrets {
  githubToken: string | null;
}

export interface SecretsProvider {
  readonly kind: string;
  getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets>;
}

/** DEV-LOCAL: secrets come straight from the gitignored owner store. */
class LocalSecretsProvider implements SecretsProvider {
  readonly kind = 'local';
  async getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets> {
    return {
      githubToken: owner.githubToken,
    };
  }
}

/** Map secret NAME -> OwnerSecrets field. */
const SECRET_FIELD: Record<SecretName, keyof OwnerSecrets> = {
  GITHUB_TOKEN: 'githubToken',
};

/** The encryption service the node-SDK attaches to a TinyCloudNode. */
interface EncryptionCapableNode {
  encryption: {
    decryptEnvelope(
      envelope: InlineEncryptedEnvelope,
      capabilityProof: { proofs: string[] },
    ): Promise<
      | { ok: true; data: Uint8Array }
      | { ok: false; error: { code: string; message: string } }
    >;
  };
}

/**
 * REAL: read the owner's secrets from TinyCloud Secrets under their stored
 * delegation, directly via the node-SDK (listen-style). Fails LOUDLY if no
 * delegation / KV miss / decrypt failure — never silent.
 */
class SdkSecretsProvider implements SecretsProvider {
  readonly kind = 'sdk';

  async getOwnerSecrets(owner: OwnerRecord): Promise<OwnerSecrets> {
    // The backend stable identity node: dstack-derived in-TEE, env in dev. The
    // same did:pkh that signed in and that owners delegated to.
    const { node } = await getBackendIdentity();

    const stored = await loadDelegation(owner.ownerId);
    if (!stored) {
      throw new Error(
        `sdk provider: no stored delegation for owner ${owner.ownerId}. ` +
          'The owner must POST /api/delegations first.',
      );
    }

    let delegation: PortableDelegation;
    try {
      delegation = deserializeDelegation(stored.serialized);
    } catch (err) {
      throw new Error(
        `sdk provider: stored delegation for owner ${owner.ownerId} is not a ` +
          `valid serialized PortableDelegation: ${String(err)}`,
      );
    }

    const out: OwnerSecrets = { githubToken: null };
    for (const name of SECRET_NAMES) {
      out[SECRET_FIELD[name]] = await this.readSecret(node, delegation, name);
    }
    return out;
  }

  /**
   * Read one secret under the owner's delegation. Ports listen
   * `backend/src/delegation-activation.ts`:
   *  - `activateResource` (re-scope `useDelegation` to the KV-get resource),
   *  - `access.kv.get(secretKey, { raw: true, prefix: "" })`,
   *  - `proofCid = access.restorable?.delegationCid ?? access.delegation.cid`,
   *  - `node.encryption.decryptEnvelope(envelope, { proofs: [proofCid] })`,
   *  - `parseSecretPayload` (`{ value }` JSON).
   */
  private async readSecret(
    node: TinyCloudNode,
    delegation: PortableDelegation,
    name: SecretName,
  ): Promise<string> {
    // The scoped vault path: vault/secrets/scoped/githaiku/<NAME>. Derived via
    // the SDK so it matches the path the owner delegated KV-get on exactly.
    const resolved = resolveSecretPath(name, { scope: GITHUB_TOKEN_SCOPE });
    const secretKey = resolved.permissionPaths.vault;

    // Re-scope the delegation to the secret's KV-get resource (listen
    // `activateResource`). The KV path must come from the secrets space.
    const secretResource = (delegation.resources ?? []).find((resource) => {
      const service = String(resource.service);
      const isKv = service === 'tinycloud.kv' || service === 'kv';
      const path = String(resource.path);
      return isKv && (path === secretKey || secretKey.startsWith(`${path.replace(/\/$/, '')}/`));
    });
    if (!secretResource) {
      throw new Error(`sdk provider: delegation does not grant KV get on ${secretKey}`);
    }

    const space =
      typeof secretResource.space === 'string' && secretResource.space.startsWith('tinycloud:')
        ? secretResource.space
        : delegation.spaceId;

    const access = await node.useDelegation({
      ...delegation,
      spaceId: space,
      path: secretKey,
      actions: ['tinycloud.kv/get'],
      resources: [{ ...secretResource, space: secretResource.space ?? delegation.spaceId }],
    });

    // Fetch the encrypted envelope from the owner's scoped secret path.
    const result = await access.kv.get<unknown>(secretKey, { raw: true, prefix: '' });
    if (!result.ok) {
      const message = result.error?.message ?? `failed to read ${secretKey}`;
      throw new Error(`sdk provider: KV get ${name} failed: ${message}`);
    }

    const envelope = parseEncryptedEnvelope((result.data as { data?: unknown } | undefined)?.data, name);

    // The decrypt proof is the delegation chain CID (listen).
    const proofCid = access.restorable?.delegationCid ?? access.delegation.cid;
    if (!proofCid) {
      throw new Error(`sdk provider: no decrypt proof available for ${name}`);
    }

    const encryption = (node as unknown as EncryptionCapableNode).encryption;
    if (!encryption) {
      throw new Error('sdk provider: TinyCloud encryption service is not available');
    }

    const decrypted = await encryption.decryptEnvelope(envelope, { proofs: [proofCid] });
    if (!decrypted.ok) {
      throw new Error(`sdk provider: decrypt ${name} failed: ${decrypted.error.message}`);
    }

    return parseSecretPayload(decrypted.data, name);
  }
}

/** Parse the inline encrypted envelope JSON read from KV (listen). */
function parseEncryptedEnvelope(rawEnvelope: unknown, name: SecretName): InlineEncryptedEnvelope {
  const parsed = typeof rawEnvelope === 'string' ? JSON.parse(rawEnvelope) : rawEnvelope;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).v !== 'number' ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).networkId !== 'string' ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).ciphertext !== 'string' ||
    typeof (parsed as Partial<InlineEncryptedEnvelope>).encryptedSymmetricKey !== 'string'
  ) {
    throw new Error(`sdk provider: secret ${name} did not contain an encrypted envelope`);
  }
  return parsed as InlineEncryptedEnvelope;
}

/** Parse the decrypted `{ value }` JSON payload (listen `parseSecretPayload`). */
function parseSecretPayload(plaintext: Uint8Array, name: SecretName): string {
  let parsed: { value?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { value?: unknown };
  } catch {
    throw new Error(`sdk provider: secret ${name} did not contain valid JSON`);
  }
  if (typeof parsed.value !== 'string') {
    throw new Error(`sdk provider: secret ${name} did not contain a string value`);
  }
  return parsed.value;
}

export function makeSecretsProvider(): SecretsProvider {
  switch (config.secretsProvider) {
    case 'local':
      return new LocalSecretsProvider();
    case 'sdk':
      return new SdkSecretsProvider();
  }
}
