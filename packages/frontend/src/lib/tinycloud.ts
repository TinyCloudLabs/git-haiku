import {
  TinyCloudWeb,
  BrowserSessionStorage,
  composeManifestRequest,
  serializeDelegation,
  type Manifest,
  type ComposedManifestRequest,
  type ClientSession,
} from '@tinycloud/web-sdk';
import type { providers } from 'ethers';

import { APP_MANIFEST, GITHUB_TOKEN_SCOPE } from './appManifest';
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

/** Encryption-network name secrets are sealed under. */
const ENCRYPTION_NETWORK_NAME = 'default';

/**
 * The owner's OWN encryption-network grant.
 *
 * `defaults: true` expands to KV + SQL only — it grants the owner NO encryption
 * capability, so a manifest-recap session (the browser path) cannot create or
 * seal to its default encryption network. `secrets.put` encrypts the payload via
 * `encryptToNetwork`, which requires the network to exist (create) and to be
 * usable (decrypt). We add this grant at compose time (owner DID is known then)
 * so the owner's signed recap covers creating + using their own default network.
 *
 * `network.create` is needed only the first time (lazy network creation);
 * `decrypt` is needed to seal/open the envelope on every put/get. This is the
 * owner's grant on their OWN network — the backend's decrypt delegation (a
 * subset: decrypt only) is unaffected.
 */
function ownerEncryptionPermission(ownerDid: string): NonNullable<Manifest['permissions']>[number] {
  return {
    service: 'tinycloud.encryption',
    space: 'encryption',
    path: defaultEncryptionNetworkId(ownerDid, ENCRYPTION_NETWORK_NAME),
    actions: ['tinycloud.encryption/network.create', 'tinycloud.encryption/decrypt'],
    skipPrefix: true,
  };
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
  // The app manifest the OWNER signs: APP_MANIFEST plus the owner's own
  // encryption-network grant (create + decrypt on their default network), which
  // `defaults: true` does not provide. Without it, `secrets.put`'s
  // `encryptToNetwork` cannot create/seal the envelope under a recap session.
  const ownerAppManifest: Manifest = {
    ...APP_MANIFEST,
    permissions: [...(APP_MANIFEST.permissions ?? []), ownerEncryptionPermission(ownerDid)],
  };
  return composeManifestRequest([
    ownerAppManifest,
    backendManifestFromServerInfo(APP_MANIFEST, info, ownerDid),
  ]);
}

/**
 * Create a TinyCloudWeb client and sign in with the OpenKey provider, signing
 * the composed capability request. Returns the live client + the request (so
 * the delegation step can materialize the backend's portion).
 *
 * Lifecycle (mirrors listen's owner sign-in): construct → clear any stale
 * persisted session for this owner → `signIn()` (full wallet flow, fresh recap)
 * → only THEN call services (`putGithubToken`, `materializeBackendDelegation`).
 *
 * Why clear the persisted session first: this is the owner SETUP path, which
 * must sign the freshly composed recap (carrying the owner's encryption-network
 * + scoped-secret grants) rather than silently restoring a stale recap that
 * lacks them. Clearing forces `signIn()` to run the full wallet flow and sign
 * the current capability request. listen does the same — it calls
 * `clearPersistedSession(addr)` before its fresh-wallet `createAndSignIn`, only
 * after restore attempts have been exhausted. (This is NOT a host workaround:
 * as of web-sdk 2.4.0-beta.11 the SDK resolves/rehydrates hosts itself, so
 * `tinycloudHosts` is left unset unless explicitly overridden — see config.ts.)
 *
 * @param ownerAddress - The owner's checksummed/lowercased address, used to
 *   target the persisted session to clear.
 * @param nonce - Backend-issued, address-bound nonce. Passed into the SIWE recap
 *   (via `siweConfig.nonce`, matching listen) so the SINGLE sign-in signature
 *   the owner produces also establishes the backend session — the signed
 *   `session.siwe` carries this nonce, which the backend validates at
 *   /api/auth/verify before issuing the session JWT.
 *
 * Returns the live client AND the resulting `ClientSession`, whose `siwe`
 * (signed message) + `signature` the caller POSTs to /api/auth/verify.
 */
export async function createAndSignIn(
  web3Provider: providers.Web3Provider,
  composedRequest: ComposedManifestRequest,
  ownerAddress: string,
  nonce: string,
): Promise<{ tcw: TinyCloudWeb; session: ClientSession }> {
  const tcw = new (TinyCloudWeb as unknown as new (cfg: unknown) => TinyCloudWeb)({
    providers: { web3: { driver: web3Provider } },
    // Optional override only — undefined lets the SDK resolve the node itself
    // (registry → node.tinycloud.xyz fallback). See config.ts.
    tinycloudHosts: TINYCLOUD_HOSTS,
    autoCreateSpace: true,
    sessionStorage: new BrowserSessionStorage(),
    // Embed the backend nonce in the SIWE message so the one sign-in signature
    // also establishes the backend session (listen passes the nonce the same way).
    siweConfig: { nonce },
    // `capabilityRequest` drives the SIWE recap, but secrets.put's
    // escalation/requestPermissions path needs the app manifest STORED on the
    // instance — so pass it explicitly (capabilityRequest still takes precedence
    // for sign-in; manifest is forwarded to the underlying TinyCloudNode).
    manifest: APP_MANIFEST,
    capabilityRequest: composedRequest,
  });
  // Some SDK signing paths still read the provider property directly.
  (tcw as unknown as { provider: providers.Web3Provider }).provider = web3Provider;
  // Owner setup must sign the freshly composed recap: clear any stale persisted
  // session so signIn() runs the full wallet flow and signs the current
  // capability request, matching listen's pre-fresh-sign-in clear.
  await tcw.clearPersistedSession(ownerAddress);
  const session = await tcw.signIn();
  return { tcw, session };
}

/**
 * Write the owner's GitHub token into their TinyCloud Secrets vault under the
 * `githaiku` scope (`vault/secrets/scoped/githaiku/GITHUB_TOKEN`, encrypted via
 * their default network). Matches the scoped path the manifest declares + the
 * backend reads.
 */
export async function putGithubToken(tcw: TinyCloudWeb, token: string): Promise<void> {
  // A manifest-recap sign-in does NOT auto-host the owner's `secrets` owned-space
  // (the SDK only auto-hosts it when neither manifest nor capabilityRequest is
  // set). Host it explicitly via the public API (idempotent, recap-authorized —
  // no extra prompt) so the first scoped put doesn't 404 "Space not found".
  await tcw.ensureOwnedSpaceHosted('secrets');
  // `secrets.put` seals the payload via the owner's default encryption network
  // (`encryptToNetwork`), which requires the network to exist — it is NOT
  // auto-created by `put`. Create-or-fetch it first (the recap grants
  // network.create + decrypt, so this needs no extra prompt).
  await tcw.ensureEncryptionNetwork(ENCRYPTION_NETWORK_NAME);
  const result = await tcw.secrets.put('GITHUB_TOKEN', token, { scope: GITHUB_TOKEN_SCOPE });
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'secrets.put failed');
  }
}

/**
 * Check whether the owner already has a GITHUB_TOKEN stored under the `githaiku`
 * scope, WITHOUT returning or logging the value. Returns true iff
 * `secrets.get` succeeds (token present + decryptable). A miss / error → false.
 *
 * Used by the returning-owner view to show "✓ token stored" instead of treating
 * the form as blank. The decrypted value is read into a local and immediately
 * discarded — it is never returned, rendered, or logged.
 */
export async function hasGithubToken(tcw: TinyCloudWeb): Promise<boolean> {
  await tcw.ensureOwnedSpaceHosted('secrets');
  const result = await tcw.secrets.get('GITHUB_TOKEN', { scope: GITHUB_TOKEN_SCOPE });
  return result.ok;
}

/**
 * Materialize the backend's manifest-declared delegation (KV-get on
 * vault/secrets/scoped/githaiku/GITHUB_TOKEN + decrypt) and serialize it for
 * POST. The owner's
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

/**
 * Restore a persisted browser session for `address`, or null if none.
 *
 * As of web-sdk 2.4.0-beta.11 a restored session rehydrates its own
 * `tinycloudHosts` (persisted at sign-in, with a registry → node.tinycloud.xyz
 * lazy fallback), so service calls (`secrets.put`, `ensureOwnedSpaceHosted`)
 * work without a fresh `signIn()`. `tinycloudHosts` is passed only as an
 * explicit override (undefined otherwise — see config.ts).
 */
export async function restoreSession(address: string): Promise<TinyCloudWeb | null> {
  const tcw = new (TinyCloudWeb as unknown as new (cfg: unknown) => TinyCloudWeb)({
    tinycloudHosts: TINYCLOUD_HOSTS,
    autoCreateSpace: false,
    sessionStorage: new BrowserSessionStorage(),
    // secrets.put can run on a restored session, which also needs the stored
    // manifest for its escalation/requestPermissions path.
    manifest: APP_MANIFEST,
  });
  const restored = await tcw.restoreSession(address);
  if (restored.status !== 'restored' || !restored.session) return null;
  return tcw;
}
