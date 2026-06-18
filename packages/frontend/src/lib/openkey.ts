import OpenKey, { OpenKeyProvider } from '@openkey/sdk';
import { providers } from 'ethers';

import { APP_NAME, OPENKEY_HOST } from './config';

/**
 * OpenKey passkey sign-in → an EIP-1193 provider the TinyCloud web-sdk can drive.
 *
 * `@openkey/sdk@0.8.x` ships `OpenKeyProvider`, an EIP-1193 wrapper around a
 * connected `OpenKey` instance. It answers `personal_sign` / `eth_sign` /
 * `eth_accounts` / `signTypedData` by routing to the user's passkey-gated key —
 * which is exactly what:
 *   - TinyCloudWeb's SIWE `signIn()` needs (it calls personal_sign), and
 *   - the backend's owner-auth signature needs (a personal_sign over the
 *     canonical "Git Haiku owner authentication" message).
 *
 * We keep the raw `openkey` instance + `keyId` around so the backend SIWE-auth
 * signatures can be produced from the SAME signer (see signOwnerAuthMessage),
 * proving the single-signer combo end to end.
 */

export interface OpenKeySession {
  /** Recovered Ethereum address (also the owner's did:pkh subject). */
  address: string;
  keyId: string;
  did: string;
  openkey: OpenKey;
  /** ethers v5 provider wrapping the OpenKey EIP-1193 provider. */
  web3Provider: providers.Web3Provider;
}

/** did:pkh for an owner Ethereum address (mainnet by default). */
export function ownerDidFromAddress(address: string, chainId = 1): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}

/**
 * Connect the owner's OpenKey passkey and build the web3 provider.
 *
 * No SIWE/session yet — that happens in the web-sdk layer (tinycloud.ts). This
 * only establishes the signer.
 */
export async function connectOpenKey(host: string = OPENKEY_HOST): Promise<OpenKeySession> {
  const openkey = new OpenKey({ host, appName: APP_NAME });
  const auth = await openkey.connect();
  const eip1193 = new OpenKeyProvider(openkey, auth);
  const web3Provider = new providers.Web3Provider(eip1193);
  return {
    address: auth.address,
    keyId: auth.keyId,
    did: ownerDidFromAddress(auth.address),
    openkey,
    web3Provider,
  };
}

/**
 * Produce the backend owner-auth signature with the SAME OpenKey signer.
 *
 * The backend (packages/backend/src/auth.ts) recovers the signer from a
 * personal_sign over `buildAuthMessage(nonce)` and burns the nonce. We sign
 * that exact message via `openkey.signMessage` (passkey-gated), giving the hex
 * signature the backend verifies — no wallet, no second signer.
 */
export async function signOwnerAuthMessage(
  session: Pick<OpenKeySession, 'openkey' | 'keyId'>,
  message: string,
): Promise<string> {
  const result = await session.openkey.signMessage({ message, keyId: session.keyId });
  return result.signature;
}
