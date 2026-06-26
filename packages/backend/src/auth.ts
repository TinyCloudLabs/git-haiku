import { randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';
import { getAddress, recoverMessageAddress, type Hex } from 'viem';

/**
 * Owner authentication — single-signature SIWE → backend session JWT.
 *
 * The owner controls the Ethereum key behind their did:pkh. They sign in ONCE
 * with the TinyCloud web-sdk: that one SIWE signature both establishes the
 * TinyCloud session AND establishes the backend session. The flow:
 *   1. GET /api/auth/nonce?address=<addr>  -> { nonce }   (one-time, address-bound)
 *   2. the web-sdk embeds that nonce in the SIWE message it asks the owner to sign
 *   3. POST /api/auth/verify { message, signature } -> verify SIWE, validate the
 *      embedded nonce (single-use), issue a session JWT -> { token, expiresIn }
 *   4. every later authed request sends `Authorization: Bearer <jwt>` — no re-sign
 *
 * Replay protection stays nonce-based (never timestamp-only, per the project's
 * crypto principles): the nonce is bound to the address, single-use, and short
 * lived. The JWT is HS256-signed with the backend's stable private key (the
 * dstack-derived, redeploy-stable identity owners already delegate to), so a
 * session restored after reload verifies against the same key.
 *
 * Mirrors listen (`packages/server/src/auth.ts`, `backend/src/routes/auth.ts`).
 */

interface NonceEntry {
  address: string;
  createdAt: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory, address-bound, single-use nonce store. The TEE backend is a single
 * instance, so an in-process map is sufficient and keeps nonces off disk.
 * Expired nonces are swept lazily on issue and periodically.
 */
class NonceStore {
  private readonly nonces = new Map<string, NonceEntry>();

  /** Issue a fresh nonce bound to `address` (lowercased). */
  issue(address: string): string {
    this.sweep();
    const normalized = address.toLowerCase();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(this.key(normalized, nonce), { address: normalized, createdAt: Date.now() });
    return nonce;
  }

  /**
   * Validate a nonce for `address`: must exist, be unexpired, and match the
   * binding. Single-use — the nonce is burned on lookup regardless of outcome.
   */
  validate(address: string, nonce: string): boolean {
    const normalized = address.toLowerCase();
    const key = this.key(normalized, nonce);
    const entry = this.nonces.get(key);
    if (!entry) return false;
    // Burn immediately — single use.
    this.nonces.delete(key);
    return Date.now() - entry.createdAt <= NONCE_TTL_MS;
  }

  private key(address: string, nonce: string): string {
    return `${address}:${nonce}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.nonces) {
      if (now - entry.createdAt > NONCE_TTL_MS) this.nonces.delete(key);
    }
  }
}

export const nonceStore = new NonceStore();

export interface OwnerAuth {
  /** Checksummed/lowercased Ethereum address of the authenticated owner. */
  address: string;
}

export class AuthError extends Error {}

// ── SIWE verification ────────────────────────────────────────────────

/**
 * Verify a SIWE message + signature and return the signer address + the nonce
 * embedded in the message.
 *
 * We do NOT use `siwe`'s `verify()` for the signature: it re-prepares the
 * message (`prepareMessage`) before hashing, so it only succeeds when the
 * backend's `siwe` version serializes byte-identically to whatever produced the
 * signed message. The web-sdk (2.4.0-beta.16) emits a recap SIWE message that
 * does NOT round-trip through `siwe@2.3.2`, so `verify()` recovers the wrong
 * address and fails. Instead we recover the signer from the EXACT signed bytes
 * (`message`) via EIP-191 personal_sign recovery — the same primitive OpenKey
 * signs with (proven by the prior per-request auth) — and use `siwe` only to
 * PARSE the address + nonce out of the message. This is version-independent.
 */
export async function verifySIWE(
  message: string,
  signature: string,
): Promise<{ address: string; nonce: string }> {
  // We parse the two EIP-4361 fields we need (the claimed address + the nonce)
  // DIRECTLY from the message text, and verify the signature by EIP-191 recovery
  // from the exact signed bytes. We deliberately do NOT use the `siwe` package:
  // (1) its `verify()` re-prepares the message before hashing, which fails on the
  // web-sdk's recap message (version-coupled), and (2) a dynamic `import('siwe')`
  // does not expose `SiweMessage` as a constructor in the esbuild ESM bundle
  // ("SiweMessage is not a constructor"). Manual parse + viem recovery is both
  // version-independent and bundle-safe.
  //
  // EIP-4361 layout: line 0 = "<domain> wants you to sign in…:", line 1 = the
  // address, and a "Nonce: <nonce>" line further down.
  const lines = message.split('\n');
  let claimed: string;
  try {
    claimed = getAddress((lines[1] ?? '').trim());
  } catch {
    throw new AuthError('SIWE message is missing a valid address on line 2');
  }
  const nonceMatch = message.match(/^Nonce: (.+)$/m);
  if (!nonceMatch || nonceMatch[1] === undefined) {
    throw new AuthError('SIWE message is missing a Nonce line');
  }
  const nonce = nonceMatch[1].trim();

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as Hex });
  } catch (err) {
    throw new AuthError(`SIWE signature recovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (getAddress(recovered) !== claimed) {
    // Detailed (logged server-side) — recovered vs expected pinpoints a real mismatch.
    throw new AuthError(
      `SIWE signature does not match message address (recovered ${recovered}, expected ${claimed})`,
    );
  }
  return { address: claimed, nonce };
}

// ── Session token (HS256 JWT) ────────────────────────────────────────

const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h, matching listen.

/**
 * Issue a session JWT signed HS256 with the backend's stable private key. The
 * subject is the wallet address. Same shape/lifetime as listen.
 */
export async function issueSessionToken(
  address: string,
  privateKey: string,
): Promise<{ token: string; expiresIn: number }> {
  const secret = new TextEncoder().encode(privateKey);
  const token = await new SignJWT({ address })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(address)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
  return { token, expiresIn: SESSION_TTL_SECONDS };
}

/**
 * Verify a session JWT issued by this backend. Returns the wallet address from
 * the token's `sub` claim. Throws AuthError on any failure (no graceful
 * fallback — an invalid/expired token surfaces as an auth error).
 */
export async function verifySessionToken(
  token: string,
  privateKey: string,
): Promise<OwnerAuth> {
  const secret = new TextEncoder().encode(privateKey);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] }));
  } catch {
    throw new AuthError('session token verification failed');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new AuthError("session token missing 'sub' claim");
  }
  return { address: payload.sub };
}
