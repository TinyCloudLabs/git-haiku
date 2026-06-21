import {
  TinyCloudWeb,
  BrowserSessionStorage,
  composeManifestRequest,
  serializeDelegation,
  type Manifest,
  type ComposedManifestRequest,
} from '@tinycloud/web-sdk';
import type { providers } from 'ethers';

import { APP_MANIFEST } from './appManifest';
import { TINYCLOUD_HOSTS } from './config';
import type { ServerInfo, ServerInfoPermission } from '../api';

/**
 * TinyCloud web-sdk wiring for the owner.
 *
 * The owner signs in once with their OpenKey-backed provider. The signed SIWE
 * recap covers BOTH the app manifest (their own secrets space) AND the backend
 * delegate manifest (composed from `/api/server-info`) so a single passkey
 * prompt authorizes everything: secrets.put + the backend delegation.
 */

export interface SignInResult {
  tcw: TinyCloudWeb;
  did: string;
  composedRequest: ComposedManifestRequest;
}

/** Default encryption-network resource id for an owner DID. */
function defaultEncryptionNetworkId(ownerDid: string, networkName = 'default'): string {
  return `urn:tinycloud:encryption:${ownerDid}:${networkName}`;
}

/**
 * Build the backend delegate manifest from its advertised permissions.
 *
 * The server-info decrypt entry is templated with `<ownerDid>`; we substitute
 * the real owner DID so the delegation targets the owner's own encryption
 * network. Lifted from listen `manifest.ts:backendManifestFromServerInfo`.
 */
function backendManifestFromServerInfo(
  appManifest: Manifest,
  info: ServerInfo,
  ownerDid: string,
): Manifest {
  const permissions: ServerInfoPermission[] = info.permissions.map((p) => ({
    ...p,
    path:
      p.service === 'tinycloud.encryption' && p.path.includes('<ownerDid>')
        ? defaultEncryptionNetworkId(ownerDid)
        : p.path,
  }));

  return {
    manifest_version: 1,
    app_id: appManifest.app_id,
    name: info.name ?? 'Git Haiku Backend',
    description: `${info.name ?? 'Backend'} access for ${appManifest.name}`,
    did: info.did,
    defaults: false,
    // ~90d delegation lifetime (sdk-core's manifest default is 30d).
    expiry: '90d',
    permissions: permissions.map((p) => ({
      service: p.service,
      ...(p.space !== undefined ? { space: p.space } : {}),
      path: p.path,
      actions: [...p.actions],
      ...(p.skipPrefix !== undefined ? { skipPrefix: p.skipPrefix } : {}),
      ...(p.description !== undefined ? { description: p.description } : {}),
    })),
  };
}

/**
 * Compose the app manifest + backend delegate manifest into one capability
 * request whose recap is signed at login. `decryptDelegateDid` = the backend
 * DID so the backend gets the broad decrypt grant.
 */
export function composeOwnerRequest(info: ServerInfo, ownerDid: string): ComposedManifestRequest {
  return composeManifestRequest([APP_MANIFEST, backendManifestFromServerInfo(APP_MANIFEST, info, ownerDid)]);
}

/**
 * Create a TinyCloudWeb client and sign in with the OpenKey provider, signing
 * the composed capability request. Returns the live client + the request (so
 * the delegation step can materialize the backend's portion).
 */
export async function createAndSignIn(
  web3Provider: providers.Web3Provider,
  composedRequest: ComposedManifestRequest,
): Promise<TinyCloudWeb> {
  const tcw = new (TinyCloudWeb as unknown as new (cfg: unknown) => TinyCloudWeb)({
    providers: { web3: { driver: web3Provider } },
    tinycloudHosts: TINYCLOUD_HOSTS,
    autoCreateSpace: true,
    sessionStorage: new BrowserSessionStorage(),
    capabilityRequest: composedRequest,
  });
  // Some SDK signing paths still read the provider property directly.
  (tcw as unknown as { provider: providers.Web3Provider }).provider = web3Provider;
  await tcw.signIn();
  return tcw;
}

/**
 * Write the owner's GitHub token into their TinyCloud Secrets vault
 * (`vault/secrets/GITHUB_TOKEN`, encrypted via their default network).
 */
export async function putGithubToken(tcw: TinyCloudWeb, token: string): Promise<void> {
  const result = await tcw.secrets.put('GITHUB_TOKEN', token);
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'secrets.put failed');
  }
}

/**
 * Materialize the backend's manifest-declared delegation (KV-get on
 * vault/secrets/GITHUB_TOKEN + decrypt) and serialize it for POST. The owner's
 * signed recap already covers these caps, so no extra prompt.
 */
export async function materializeBackendDelegation(
  tcw: TinyCloudWeb,
  backendDid: string,
  composedRequest: ComposedManifestRequest,
): Promise<string> {
  if (composedRequest.delegationTargets.length === 0) {
    throw new Error('composed request has no delegation targets — nothing to delegate');
  }
  const result = await tcw.materializeDelegation(backendDid, composedRequest);
  return serializeDelegation(result.delegation);
}

/** Restore a persisted browser session for `address`, or null if none. */
export async function restoreSession(address: string): Promise<TinyCloudWeb | null> {
  const tcw = new (TinyCloudWeb as unknown as new (cfg: unknown) => TinyCloudWeb)({
    tinycloudHosts: TINYCLOUD_HOSTS,
    autoCreateSpace: false,
    sessionStorage: new BrowserSessionStorage(),
  });
  const restored = await tcw.restoreSession(address);
  if (restored.status !== 'restored' || !restored.session) return null;
  return tcw;
}
