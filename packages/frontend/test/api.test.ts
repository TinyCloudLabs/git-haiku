import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateLastWeekReport,
  mintCode,
  previewHaiku,
  registerOwner,
  requestNonce,
  requestWeeklyReport,
  sendDelegation,
  verifySession,
  type OwnerAuthContext,
} from '../src/api';

/**
 * Verifies the bearer-token auth model (matching the backend's JWT session
 * scheme in packages/backend/src/auth.ts): authed calls send
 * `Authorization: Bearer <token>` with NO per-request signing. The session
 * helpers (requestNonce, verifySession) carry the one-time SIWE handshake.
 */

const auth: OwnerAuthContext = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  token: 'header.payload.signature',
};

afterEach(() => vi.restoreAllMocks());

/** Mock fetch capturing the headers + body sent to the target endpoint. */
function mockBackend(targetBody: unknown, status = 200) {
  const captured: { url?: string; headers?: Record<string, string>; body?: string; method?: string } = {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.headers = init?.headers as Record<string, string>;
    captured.body = init?.body as string;
    captured.method = init?.method;
    return new Response(JSON.stringify(targetBody), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { captured, fetchMock };
}

describe('session handshake helpers', () => {
  it('requestNonce GETs /api/auth/nonce with the address and returns the nonce', async () => {
    const { captured } = mockBackend({ nonce: 'deadbeefcafef00d' });
    const nonce = await requestNonce(auth.address);
    expect(nonce).toBe('deadbeefcafef00d');
    expect(captured.url).toContain('/api/auth/nonce');
    expect(captured.url).toContain(`address=${encodeURIComponent(auth.address)}`);
  });

  it('verifySession POSTs the SIWE message + signature and returns the token', async () => {
    const { captured } = mockBackend({ token: 'jwt-token', expiresIn: 86400 });
    const res = await verifySession('siwe-message', '0xsig');
    expect(res).toEqual({ token: 'jwt-token', expiresIn: 86400 });
    expect(captured.url).toContain('/api/auth/verify');
    expect(captured.method).toBe('POST');
    expect(JSON.parse(captured.body!)).toEqual({ message: 'siwe-message', signature: '0xsig' });
  });
});

describe('bearer-token authed calls', () => {
  it('registerOwner sends the bearer token and does NOT fetch a nonce per call', async () => {
    const { captured, fetchMock } = mockBackend({
      ownerId: 'own_x',
      secretCode: 'aaaa-bbbb',
      codeId: 'cid',
      githubLogin: 'octocat',
      hasGithubToken: true,
    });

    await registerOwner(auth, { githubLogin: 'octocat' });

    expect(captured.headers!.authorization).toBe(`Bearer ${auth.token}`);
    // No per-request signing: only the single owner endpoint is hit, no nonce.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/api/auth/nonce'))).toBe(false);
  });

  it('sendDelegation posts ownerId + serialized with the bearer token', async () => {
    const { captured } = mockBackend({ status: 'active', expiresAt: '2026-09-01' });
    await sendDelegation(auth, { ownerId: 'own_x', serialized: '{"d":1}' });
    expect(JSON.parse(captured.body!)).toEqual({ ownerId: 'own_x', serialized: '{"d":1}' });
    expect(captured.headers!.authorization).toBe(`Bearer ${auth.token}`);
  });

  it('reuses the same token across calls — no re-signing', async () => {
    const { fetchMock } = mockBackend({ codeId: 'c', secretCode: 's' });
    await mintCode(auth);
    await mintCode(auth);
    const nonceCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/auth/nonce'));
    expect(nonceCalls.length).toBe(0);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${auth.token}`);
    }
  });

  it('generateLastWeekReport POSTs with the bearer token', async () => {
    const { captured } = mockBackend({
      githubLogin: 'octocat',
      generatedAt: '2026-06-29T00:00:00Z',
      range: { start: '2026-06-22', end: '2026-06-28' },
      commitCount: 1,
      generatedBy: 'deterministic',
      overview: 'Shipped one focused change.',
      days: [
        {
          date: '2026-06-22',
          weekday: 'Monday',
          commitCount: 1,
          repos: ['octocat/hello'],
          summary: 'Worked on octocat/hello.',
          highlights: ['hello: feat: add report'],
        },
      ],
    });

    const report = await generateLastWeekReport(auth);

    expect(captured.method).toBe('POST');
    expect(captured.url).toContain('/api/reports/last-week');
    expect(captured.headers!.authorization).toBe(`Bearer ${auth.token}`);
    expect(report.overview).toMatch(/focused/);
  });
});

describe('previewHaiku', () => {
  it('POSTs /api/preview with the bearer token and returns the haiku on 200', async () => {
    const { captured } = mockBackend(
      {
        allowed: true,
        haiku: { lines: ['one two three four five', 'six seven eight nine ten eleven', 'twelve thirteen'] },
        author: { githubLogin: 'octocat' },
        proof: { policy_id: 'p', image_digest: null, attestation_url: null },
      },
      200,
    );

    const res = await previewHaiku(auth);

    expect(captured.method).toBe('POST');
    expect(captured.url).toContain('/api/preview');
    expect(captured.headers!.authorization).toBe(`Bearer ${auth.token}`);
    expect(res.allowed).toBe(true);
    if (res.allowed) expect(res.haiku.lines).toHaveLength(3);
  });

  it('returns the staged denial body on a non-2xx response', async () => {
    mockBackend({ allowed: false, reason: 'no token', stage: 'secrets' }, 422);
    const res = await previewHaiku(auth);
    expect(res.allowed).toBe(false);
    if (!res.allowed) expect(res.stage).toBe('secrets');
  });

  it('throws when the body is not a valid preview shape', async () => {
    mockBackend({ oops: true }, 500);
    await expect(previewHaiku(auth)).rejects.toThrow(/preview failed/);
  });
});

describe('requestWeeklyReport', () => {
  it('POSTs the share code to the public report endpoint', async () => {
    const { captured } = mockBackend({
      allowed: true,
      report: {
        githubLogin: 'octocat',
        generatedAt: '2026-06-29T00:00:00Z',
        range: { start: '2026-06-22', end: '2026-06-28' },
        commitCount: 1,
        generatedBy: 'deterministic',
        overview: 'Shipped one focused change.',
        days: [],
      },
    });

    const report = await requestWeeklyReport('aaaa-bbbb');

    expect(captured.method).toBe('POST');
    expect(captured.url).toContain('/api/reports/last-week/share');
    expect(JSON.parse(captured.body!)).toEqual({ code: 'aaaa-bbbb' });
    expect(report.allowed).toBe(true);
  });
});
