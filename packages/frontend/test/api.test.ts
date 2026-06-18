import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, getAddress } from 'viem';

import {
  AUTH_MESSAGE_PREFIX,
  buildAuthMessage,
  mintCode,
  registerOwner,
  sendDelegation,
  type OwnerAuthContext,
} from '../src/api';

/**
 * Verifies the owner-auth header scheme end-to-end against the backend's
 * verification logic (packages/backend/src/auth.ts): GET /api/auth/nonce → sign
 * buildAuthMessage(nonce) → send x-githaiku-{address,nonce,signature}. We use a
 * real viem account as the signer so the signature is genuinely recoverable.
 */

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const auth: OwnerAuthContext = {
  address: account.address,
  sign: (message) => account.signMessage({ message }),
};

afterEach(() => vi.restoreAllMocks());

/** Mock fetch: nonce endpoint then the target endpoint, capturing headers. */
function mockBackend(targetBody: unknown) {
  const captured: { headers?: Record<string, string>; body?: string } = {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/auth/nonce')) {
      return new Response(JSON.stringify({ nonce: 'deadbeefcafef00d' }), { status: 200 });
    }
    captured.headers = init?.headers as Record<string, string>;
    captured.body = init?.body as string;
    return new Response(JSON.stringify(targetBody), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { captured, fetchMock };
}

describe('owner-auth headers', () => {
  it('buildAuthMessage matches the backend canonical message', () => {
    expect(buildAuthMessage('abc')).toBe(`${AUTH_MESSAGE_PREFIX}\n\nNonce: abc`);
  });

  it('registerOwner sends a recoverable SIWE signature for the claimed address', async () => {
    const { captured } = mockBackend({
      ownerId: 'own_x',
      secretCode: 'aaaa-bbbb',
      codeId: 'cid',
      githubLogin: 'octocat',
      hasGithubToken: true,
    });

    await registerOwner(auth, { githubLogin: 'octocat' });

    const h = captured.headers!;
    expect(getAddress(h['x-githaiku-address'])).toBe(getAddress(account.address));
    expect(h['x-githaiku-nonce']).toBe('deadbeefcafef00d');

    const recovered = await recoverMessageAddress({
      message: buildAuthMessage(h['x-githaiku-nonce']),
      signature: h['x-githaiku-signature'] as `0x${string}`,
    });
    expect(getAddress(recovered)).toBe(getAddress(account.address));
  });

  it('sendDelegation posts ownerId + serialized with auth headers', async () => {
    const { captured } = mockBackend({ status: 'active', expiresAt: '2026-09-01' });
    await sendDelegation(auth, { ownerId: 'own_x', serialized: '{"d":1}' });
    expect(JSON.parse(captured.body!)).toEqual({ ownerId: 'own_x', serialized: '{"d":1}' });
    expect(captured.headers!['x-githaiku-signature']).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('each authed call fetches a fresh nonce (one-time use)', async () => {
    const { fetchMock } = mockBackend({ codeId: 'c', secretCode: 's' });
    await mintCode(auth);
    await mintCode(auth);
    const nonceCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/auth/nonce'));
    expect(nonceCalls.length).toBe(2);
  });
});
