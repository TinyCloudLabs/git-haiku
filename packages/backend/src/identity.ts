import {
  createServerIdentity,
  deriveDstackPrivateKey,
  serverDidForPrivateKey,
  withSessionRefresh,
  type ServerIdentity,
} from '@tinycloud/server';
import type { Manifest } from '@tinycloud/node-sdk';

import { config } from './config';
import { getDstackClient, shouldUseDstack } from './tee';

const BACKEND_KEY_PATH = 'githaiku/keys/backend';
const BACKEND_KEY_PURPOSE = 'backend';

export async function deriveTeeBackendKey(): Promise<`0x${string}`> {
  return deriveDstackPrivateKey({
    client: getDstackClient(),
    path: BACKEND_KEY_PATH,
    purpose: BACKEND_KEY_PURPOSE,
  });
}

export const backendDidForPrivateKey = serverDidForPrivateKey;

let cachedPrivateKey: string | null = null;

export async function resolveBackendPrivateKey(): Promise<string> {
  if (cachedPrivateKey) return cachedPrivateKey;

  if (shouldUseDstack()) {
    cachedPrivateKey = await deriveTeeBackendKey();
    return cachedPrivateKey;
  }
  const envKey = config.backendPrivateKey;
  if (!envKey) {
    throw new Error(
      'GITHAIKU_BACKEND_PRIVATE_KEY is required for the sdk secrets provider ' +
        'outside the TEE (it is the backend stable identity that owners delegate to). ' +
        'Set it, run inside a dstack TEE (GITHAIKU_TEE=1), or use GITHAIKU_SECRETS_PROVIDER=local.',
    );
  }
  cachedPrivateKey = envKey;
  return envKey;
}

export type BackendIdentity = ServerIdentity;

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

export async function getBackendIdentity(): Promise<BackendIdentity> {
  if (cached) return cached;

  const privateKey = await resolveBackendPrivateKey();
  const prefix = 'githaiku-be';

  cached = await createServerIdentity({
    privateKey,
    host: config.nodeHost,
    prefix,
    autoCreateSpace: true,
    enablePublicSpace: false,
    manifest: backendIdentityManifest(prefix),
    includeAccountRegistryPermissions: false,
  });
  return cached;
}

export function resetBackendIdentity(): void {
  cached = null;
  cachedPrivateKey = null;
}

export { withSessionRefresh };
