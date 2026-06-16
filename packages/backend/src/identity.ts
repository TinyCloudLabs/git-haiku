import { TinyCloudNode, type Manifest } from '@tinycloud/node-sdk';

import { config } from './config';

/**
 * Backend identity.
 *
 * The backend has a STABLE TinyCloud identity (a did:pkh from an Ethereum
 * private key). Owners delegate KV-get + decrypt on their secrets to THIS DID,
 * and the backend reads those secrets under the delegation. The audience of an
 * owner's delegation must be this stable did:pkh — never an ephemeral session
 * did:key (the proven fix).
 *
 * Lifted from listen `packages/server/src/identity.ts`.
 *
 * KEY SOURCE SEAM:
 *  - local/verification: the key comes from GITHAIKU_BACKEND_PRIVATE_KEY.
 *  - eventual TEE: dstack `get_key("githaiku/keys/backend")` from
 *    /var/run/dstack.sock, so the key never exists outside the TEE. NOT
 *    implemented here — this module is the seam it slots into.
 */

export interface BackendIdentity {
  node: TinyCloudNode;
  /** Stable did:pkh. The audience of every owner delegation. */
  did: string;
  host: string;
}

function backendIdentityManifest(prefix: string): Manifest {
  return {
    manifest_version: 1,
    app_id: 'xyz.tinycloud.githaiku.backend',
    name: 'Git Haiku Backend',
    defaults: false,
    permissions: [
      {
        service: 'tinycloud.kv',
        space: prefix,
        path: 'delegations/',
        actions: ['get', 'put', 'del', 'list', 'metadata'],
        skipPrefix: true,
      },
    ],
  };
}

let cached: BackendIdentity | null = null;

/**
 * Initialize the backend's TinyCloudNode from the configured private key, sign
 * in, and return the node + its stable did:pkh. Memoized: one identity per
 * process.
 */
export async function getBackendIdentity(): Promise<BackendIdentity> {
  if (cached) return cached;

  const privateKey = config.backendPrivateKey;
  if (!privateKey) {
    throw new Error(
      'GITHAIKU_BACKEND_PRIVATE_KEY is required for the tc-cli secrets provider ' +
        '(it is the backend stable identity that owners delegate to). ' +
        'Set it, or run with GITHAIKU_SECRETS_PROVIDER=local (default).',
    );
  }

  const prefix = 'githaiku-be';
  const host = config.nodeHost;
  const node = new TinyCloudNode({
    privateKey,
    host,
    prefix,
    autoCreateSpace: true,
    enablePublicSpace: false,
    manifest: backendIdentityManifest(prefix),
    includeAccountRegistryPermissions: false,
  });

  await node.signIn();

  cached = { node, did: node.did, host };
  return cached;
}

/** Reset memoized identity (tests only). */
export function resetBackendIdentity(): void {
  cached = null;
}
