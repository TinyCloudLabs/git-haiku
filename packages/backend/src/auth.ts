import { randomBytes } from 'node:crypto';

import { getAddress, recoverMessageAddress, type Hex } from 'viem';

/**
 * Owner authentication — SIWE-style signature over a server nonce.
 *
 * The owner controls the Ethereum key behind their did:pkh. To authenticate
 * (POST /api/delegations, /api/owner, code management, audit read) they:
 *   1. GET /api/auth/nonce            -> { nonce }   (one-time, short-lived)
 *   2. sign the canonical message     (their wallet / OpenKey key)
 *   3. send { address, nonce, signature } on the authenticated request
 *
 * The backend recovers the signer from the signature + canonical message and
 * confirms it equals the claimed address, then BURNS the nonce (replay
 * protection — nonce-based, never timestamp-only, per the project's crypto
 * principles). This is self-contained: no dependency on the private
 * @tinyboilerplate session-token package tinychat uses.
 */

export const AUTH_MESSAGE_PREFIX = 'Git Haiku owner authentication';

/** The exact message the owner signs. Binds the action to a one-time nonce. */
export function buildAuthMessage(nonce: string): string {
  return `${AUTH_MESSAGE_PREFIX}\n\nNonce: ${nonce}`;
}

interface NonceEntry {
  expiresAt: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * In-memory one-time nonce store. The TEE backend is a single instance, so an
 * in-process set is sufficient and keeps nonces off disk. Expired nonces are
 * swept lazily on issue.
 */
class NonceStore {
  private readonly nonces = new Map<string, NonceEntry>();

  issue(): string {
    this.sweep();
    const nonce = randomBytes(16).toString('hex');
    this.nonces.set(nonce, { expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Consume a nonce: valid + unexpired => true and it is burned. */
  consume(nonce: string): boolean {
    const entry = this.nonces.get(nonce);
    if (!entry) return false;
    this.nonces.delete(nonce);
    return entry.expiresAt > Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt <= now) this.nonces.delete(nonce);
    }
  }
}

export const nonceStore = new NonceStore();

export interface OwnerAuth {
  /** Recovered, checksummed Ethereum address of the authenticated owner. */
  address: string;
}

export class AuthError extends Error {}

/**
 * Verify an owner-auth payload. Recovers the signer from the signature over the
 * canonical message for the supplied nonce, confirms it matches the claimed
 * address, and burns the nonce. Throws AuthError on any failure.
 */
export async function verifyOwnerAuth(input: {
  address?: unknown;
  nonce?: unknown;
  signature?: unknown;
}): Promise<OwnerAuth> {
  const address = typeof input.address === 'string' ? input.address : '';
  const nonce = typeof input.nonce === 'string' ? input.nonce : '';
  const signature = typeof input.signature === 'string' ? input.signature : '';

  if (!address || !nonce || !signature) {
    throw new AuthError('address, nonce and signature are required');
  }

  // Burn the nonce FIRST so a failed verification can't be retried with it.
  if (!nonceStore.consume(nonce)) {
    throw new AuthError('invalid or expired nonce');
  }

  let recovered: string;
  try {
    recovered = await recoverMessageAddress({
      message: buildAuthMessage(nonce),
      signature: signature as Hex,
    });
  } catch {
    throw new AuthError('signature verification failed');
  }

  let claimed: string;
  try {
    claimed = getAddress(address);
  } catch {
    throw new AuthError('invalid address');
  }

  if (getAddress(recovered) !== claimed) {
    throw new AuthError('signature does not match address');
  }

  return { address: claimed };
}
