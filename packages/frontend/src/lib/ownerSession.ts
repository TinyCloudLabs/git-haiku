import type { TinyCloudWeb, ComposedManifestRequest } from '@tinycloud/web-sdk';

import { type OwnerAuthContext } from '../api';
import { connectOpenKey, signOwnerAuthMessage, type OpenKeySession } from './openkey';
import { createAndSignIn, composeOwnerRequest } from './tinycloud';
import { getServerInfo } from '../api';

/**
 * A fully signed-in owner session: the OpenKey signer, the TinyCloud web client,
 * the backend server-info + composed capability request, and a ready-to-use
 * `OwnerAuthContext` whose `sign` produces backend owner-auth signatures from
 * the SAME OpenKey key.
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
 *   4. web-sdk signIn() (single passkey prompt covers secrets + delegation)
 *
 * Throws with a precise message if any link fails (no graceful fallbacks).
 */
export async function signInOwner(): Promise<OwnerSession> {
  const openkey = await connectOpenKey();

  const info = await getServerInfo();
  const composedRequest = composeOwnerRequest(info, openkey.did);

  const tcw = await createAndSignIn(openkey.web3Provider, composedRequest);

  const auth: OwnerAuthContext = {
    address: openkey.address,
    sign: (message) => signOwnerAuthMessage(openkey, message),
  };

  return {
    openkey,
    tcw,
    did: openkey.did,
    backendDid: info.did,
    composedRequest,
    auth,
  };
}
