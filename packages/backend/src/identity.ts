import { keccak256, type Hex } from 'viem';
import { TinyCloudNode, type Manifest } from '@tinycloud/node-sdk';

import { config } from './config';
import { getDstackClient, inTee } from './tee';

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
 * KEY SOURCE:
 *  - IN-TEE (the real path): the key is DERIVED inside the dstack TEE via
 *    `getKey('githaiku/keys/backend', 'backend')` over the guest-agent socket.
 *    The derived key material never leaves the TEE — it is produced fresh in the
 *    enclave on every boot and is tied to the app's measurement.
 *  - LOCAL/DEV: the key comes from GITHAIKU_BACKEND_PRIVATE_KEY (the dev/
 *    verification fallback so the live test + local tc-cli path still work).
 */

const BACKEND_KEY_PATH = 'githaiku/keys/backend';
const BACKEND_KEY_PURPOSE = 'backend';

/**
 * Derive the backend's stable Ethereum private key inside the TEE.
 *
 * dstack `getKey` returns 32 bytes of enclave-bound key material. We hash it
 * with keccak256 to a uniformly-distributed 32-byte secp256k1 private key (the
 * same shape TinyCloudNode expects). Deterministic per app measurement + path,
 * so the backend DID is stable across reboots of the same image.
 */
async function deriveTeeBackendKey(): Promise<Hex> {
  const client = getDstackClient();
  const res = await client.getKey(BACKEND_KEY_PATH, BACKEND_KEY_PURPOSE);
  if (!(res.key instanceof Uint8Array) || res.key.length === 0) {
    throw new Error('dstack getKey returned no key material');
  }
  // keccak256 of the raw enclave key -> a valid 32-byte secp256k1 private key.
  return keccak256(res.key);
}

/**
 * Resolve the backend private key for this process: dstack-derived in-TEE, env
 * fallback otherwise. Fails loudly if neither is available — never silent.
 */
async function resolveBackendPrivateKey(): Promise<string> {
  if (inTee()) {
    return deriveTeeBackendKey();
  }
  const envKey = config.backendPrivateKey;
  if (!envKey) {
    throw new Error(
      'GITHAIKU_BACKEND_PRIVATE_KEY is required for the tc-cli secrets provider ' +
        'outside the TEE (it is the backend stable identity that owners delegate to). ' +
        'Set it, run inside a dstack TEE (GITHAIKU_TEE=1), or use GITHAIKU_SECRETS_PROVIDER=local.',
    );
  }
  return envKey;
}

export interface BackendIdentity {
  node: TinyCloudNode;
  /** Stable did:pkh. The audience of every owner delegation. */
  did: string;
  host: string;
  /**
   * The resolved backend private key (dstack-derived in-TEE, env in dev). The
   * tc-cli secrets provider passes this to the `tc` binary as TC_PRIVATE_KEY so
   * the delegated read uses the SAME identity that signed in here.
   */
  privateKey: string;
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

  const privateKey = await resolveBackendPrivateKey();

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

  cached = { node, did: node.did, host, privateKey };
  return cached;
}

/** Reset memoized identity (tests only). */
export function resetBackendIdentity(): void {
  cached = null;
}

// ── Session refresh wrapper (lifted from listen identity.ts) ──────────

const SESSION_ERROR_PATTERN =
  /\b(session\s+expired|invalid\s+session|token\s+expired|expired\s+credentials?|unauthorized|unauthenticated|sign.?in\s*required)\b|\b401\b(?![\d-])/i;

function isSessionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return SESSION_ERROR_PATTERN.test(message);
}

/**
 * Wrap a TinyCloud KV op so a session-expiry error triggers one re-sign-in +
 * retry. Lifted from listen `packages/server/src/identity.ts`.
 */
export async function withSessionRefresh<T>(node: TinyCloudNode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isSessionError(err)) {
      await node.signIn();
      return fn();
    }
    throw err;
  }
}
