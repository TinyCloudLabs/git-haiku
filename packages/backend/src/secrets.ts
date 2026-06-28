import {
  createServerDelegateClient,
} from '@tinycloud/server';
import { deserializeDelegation, type PortableDelegation } from '@tinycloud/node-sdk';

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
    const { node, privateKey, host } = await getBackendIdentity();

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
    const client = createServerDelegateClient({
      privateKey,
      host,
      delegation,
      node,
    });
    for (const name of SECRET_NAMES) {
      out[SECRET_FIELD[name]] = await client.getSecret(name, { scope: GITHUB_TOKEN_SCOPE });
    }
    return out;
  }
}

export function makeSecretsProvider(): SecretsProvider {
  switch (config.secretsProvider) {
    case 'local':
      return new LocalSecretsProvider();
    case 'sdk':
      return new SdkSecretsProvider();
  }
}
