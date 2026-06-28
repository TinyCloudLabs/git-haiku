import { type OwnerAuthContext } from '../api';
import { connectOpenKey, type OpenKeySession } from './openkey';
import { requestNonce, verifySession } from '../api';

/**
 * A signed-in owner session.
 *
 * Login is LIGHTWEIGHT: a single OpenKey `personal_sign` over a minimal
 * EIP-4361 message (carrying the backend nonce) establishes the backend session
 * JWT. It does NOT run the heavy web-sdk recap (`signIn()` of the composed app +
 * backend manifests). That recap is needed only for SETUP (storing the GitHub
 * token + minting the backend delegation) and is deferred to the setup phase —
 * a returning owner never triggers it.
 *
 * The dashboard needs only `{ did, auth }`: every dashboard call is a backend
 * JWT call. `openkey` is carried so the setup phase can drive the web-sdk recap
 * with the SAME OpenKey provider already in hand.
 */
export interface OwnerSession {
  openkey: OpenKeySession;
  /** did:pkh of the owner — shown on the dashboard. */
  did: string;
  /** Pass to api.ts authed calls. */
  auth: OwnerAuthContext;
}

/**
 * Build a MINIMAL EIP-4361 (SIWE) message the backend can authenticate.
 *
 * The backend's `verifySIWE` recovers the signer via EIP-191 personal_sign from
 * the EXACT signed bytes and only PARSES two fields out of the text: the address
 * (line 2 / index 1) and a `Nonce: <nonce>` line. It does NOT round-trip the
 * message through the `siwe` package, so any well-formed EIP-4361 message that
 * carries the address on line 2 and the backend nonce authenticates — no web-sdk
 * recap is required.
 *
 * Layout matches EIP-4361:
 *   line 0: "<domain> wants you to sign in with your Ethereum account:"
 *   line 1: <address>
 *   line 2: (blank)
 *   line 3: <statement>
 *   line 4: (blank)
 *   then the URI / Version / Chain ID / Nonce / Issued At fields.
 */
function buildLoginSiweMessage(params: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
}): string {
  const { domain, address, uri, chainId, nonce } = params;
  const issuedAt = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to Git Haiku.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

/**
 * Lightweight owner login:
 *   1. OpenKey passkey connect → signer + address
 *   2. GET an address-bound nonce from the backend
 *   3. construct a MINIMAL EIP-4361 SIWE message carrying the nonce
 *   4. sign it with ONE OpenKey `personal_sign` (EIP-191 — the same primitive the
 *      backend verifies)
 *   5. POST message + signature to /api/auth/verify → session JWT
 *
 * No composed recap, no web-sdk `signIn()` — those happen only at SETUP. A
 * returning owner lands on the dashboard with exactly this one signature.
 *
 * Throws with a precise message if any link fails (no graceful fallbacks).
 */
export async function signInOwner(): Promise<OwnerSession> {
  const openkey = await connectOpenKey();

  const nonce = await requestNonce(openkey.address);

  const message = buildLoginSiweMessage({
    // The app domain the owner signs against. Use the live origin so the message
    // is meaningful in the wallet UI; the backend only parses address + nonce.
    domain: typeof window !== 'undefined' ? window.location.host : 'githaiku.com',
    address: openkey.address,
    uri: typeof window !== 'undefined' ? window.location.origin : 'https://githaiku.com',
    chainId: 1,
    nonce,
  });

  // ONE signature. `personal_sign` via the OpenKey-backed signer — the same
  // EIP-191 primitive the backend recovers from in verifySIWE.
  const signature = await openkey.web3Provider.getSigner().signMessage(message);

  const { token } = await verifySession(message, signature);

  const auth: OwnerAuthContext = { address: openkey.address, token };

  return {
    openkey,
    did: openkey.did,
    auth,
  };
}
