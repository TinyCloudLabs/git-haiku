import type { TinyCloudWeb, ComposedManifestRequest } from '@tinycloud/web-sdk';

import { type OwnerAuthContext } from '../api';
import { connectOpenKey, type OpenKeySession } from './openkey';
import { createAndSignIn, composeOwnerRequest } from './tinycloud';
import { getServerInfo, requestNonce, verifySession } from '../api';

/**
 * A fully signed-in owner session: the OpenKey signer, the TinyCloud web client,
 * the backend server-info + composed capability request, and a ready-to-use
 * `OwnerAuthContext` carrying the backend session JWT established from the SAME
 * single SIWE sign-in signature.
 */
export interface OwnerSession {
  openkey: OpenKeySession;
  tcw: TinyCloudWeb;
  did: string;
  backendDid: string;
  composedRequest: ComposedManifestRequest;
  /** Pass to api.ts authed calls. */
  auth: OwnerAuthContext;
}

/**
 * Drive the full sign-in:
 *   1. OpenKey passkey connect → signer + web3 provider
 *   2. fetch /api/server-info (backend DID + delegation policy)
 *   3. compose app + backend manifests → signed capability request
 *   4. GET an address-bound nonce from the backend
 *   5. web-sdk signIn() — a SINGLE passkey prompt covers secrets + delegation
 *      AND, by embedding the nonce in the SIWE message, the backend session
 *   6. POST the signed SIWE message + signature to /api/auth/verify → session JWT
 *
 * The one signature does it all: no separate per-request backend signing.
 * Throws with a precise message if any link fails (no graceful fallbacks).
 */
export async function signInOwner(): Promise<OwnerSession> {
  const openkey = await connectOpenKey();

  const info = await getServerInfo();
  const composedRequest = composeOwnerRequest(info, openkey.did);

  const nonce = await requestNonce(openkey.address);
  const { tcw, session } = await createAndSignIn(
    openkey.web3Provider,
    composedRequest,
    openkey.address,
    nonce,
  );

  // The single sign-in signature establishes the backend session: the signed
  // SIWE message carries the nonce the backend validates before issuing the JWT.
  const { token } = await verifySession(session.siwe, session.signature);

  const auth: OwnerAuthContext = { address: openkey.address, token };

  return {
    openkey,
    tcw,
    did: openkey.did,
    backendDid: info.did,
    composedRequest,
    auth,
  };
}
