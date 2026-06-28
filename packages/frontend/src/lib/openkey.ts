import OpenKey, { OpenKeyProvider } from '@openkey/sdk';
import { providers } from 'ethers';

import { APP_NAME, OPENKEY_HOST } from './config';

/**
 * OpenKey passkey sign-in → an EIP-1193 provider the TinyCloud web-sdk can drive.
 *
 * `@openkey/sdk@0.8.x` ships `OpenKeyProvider`, an EIP-1193 wrapper around a
 * connected `OpenKey` instance. It answers `personal_sign` / `eth_sign` /
 * `eth_accounts` / `signTypedData` by routing to the user's passkey-gated key —
 * which is exactly what TinyCloudWeb's SIWE `signIn()` needs (it calls
 * personal_sign). That single sign-in signature also establishes the backend
 * session (its SIWE message carries the backend nonce), so no second signer or
 * per-request signature is needed.
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
