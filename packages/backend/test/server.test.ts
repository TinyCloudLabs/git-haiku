import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EGRESS_POLICY_ID } from '@githaiku/shared';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the dev store at a throwaway dir BEFORE importing modules that read config.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-test-'));
process.env.GITHAIKU_DATA_DIR = DATA_DIR;
// The backend signs/verifies session JWTs with its stable private key. Outside
// the TEE that key comes from env; set a throwaway anvil key for the suite.
process.env.GITHAIKU_BACKEND_PRIVATE_KEY =
  '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e';
// These tests assert the deterministic haiku; force it so the suite never makes
// a live RedPill call (e.g. if REDPILL_API_KEY is present in the environment).
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
// Generous rate limit so the functional tests don't trip it; a dedicated test
// re-imports the server with a tiny limit.
process.env.GITHAIKU_HAIKU_RATE_MAX = '1000';

const { buildServer } = await import('../src/server');
const { createOwner } = await import('../src/store');
const { codeIdFor, resetAuditCoalescing } = await import('../src/audit');

const app = await buildServer();

// Throwaway anvil keys, one per logical owner wallet (one address = one owner).
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca3a545d9f2bc5b642b3ee6cca3a637f1d2d1765f37c13',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
] as const;

/**
 * Drive the single-signature SIWE → JWT flow for a wallet and return the
 * `Authorization: Bearer <jwt>` header used by every authed call. Mirrors the
 * frontend: GET an address-bound nonce → sign a SIWE message embedding it →
 * POST /api/auth/verify → use the returned JWT. (default: wallet 0).
 */
async function authHeaders(keyIndex = 0): Promise<Record<string, string>> {
  const acct = privateKeyToAccount(ANVIL_KEYS[keyIndex]!);
  const nonceRes = await app.inject({
    method: 'GET',
    url: `/api/auth/nonce?address=${acct.address}`,
  });
  const { nonce } = JSON.parse(nonceRes.body);
  const message = new SiweMessage({
    domain: 'localhost',
    address: acct.address,
    statement: 'Git Haiku owner sign-in',
    uri: 'http://localhost',
    version: '1',
    chainId: 1,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await acct.signMessage({ message });
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { message, signature },
  });
  const { token } = JSON.parse(verifyRes.body);
  return { authorization: `Bearer ${token}` };
}

let secretCode: string;

beforeAll(async () => {
  await app.ready();
  // Owner with no GitHub token -> haiku renders from the dev fixture.
  secretCode = createOwner({ githubLogin: 'octocat' }).secretCode;
});

afterAll(async () => {
  await app.close();
});

describe('POST /api/haiku', () => {
  it('returns a guarded 3-line haiku for a valid code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secretCode } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.allowed).toBe(true);
    expect(body.haiku.lines).toHaveLength(3);
    body.haiku.lines.forEach((line: unknown) => expect(typeof line).toBe('string'));
    expect(body.proof.policy_id).toBe(EGRESS_POLICY_ID);
    // Dev placeholder proof.
    expect(body.proof.image_digest).toBeNull();
    expect(body.proof.attestation_url).toBeNull();
    // Trust contract: no commit data fields anywhere.
    expect(body).not.toHaveProperty('commits');
    expect(JSON.stringify(body)).not.toContain('feat:');
  });

  it('is deterministic: same code -> same haiku', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secretCode } });
    const b = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secretCode } });
    expect(JSON.parse(a.body).haiku.lines).toEqual(JSON.parse(b.body).haiku.lines);
  });

  it('returns a clean denial with NO commit data for a wrong code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: 'totally-wrong-code' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ allowed: false, reason: 'invalid code' });
    expect(body).not.toHaveProperty('haiku');
    expect(body).not.toHaveProperty('commits');
  });

  it('returns a clean denial for a missing code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: {} });
    expect(JSON.parse(res.body)).toEqual({ allowed: false, reason: 'invalid code' });
  });

  it('returns a staged guarded denial for an upstream GitHub failure', async () => {
    const realFetch = global.fetch;
    global.fetch = (async () => new Response('upstream failed with commit secret', { status: 500 })) as typeof fetch;
    try {
      const failingCode = createOwner({
        githubLogin: 'octocat',
        githubToken: 'ghp_test_operational_failure',
      }).secretCode;
      const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: failingCode } });
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      // Staged, still-safe denial: generic reason + the `github` stage, no data.
      expect(body).toEqual({ allowed: false, reason: 'could not read your GitHub activity', stage: 'github' });
      expect(body).not.toHaveProperty('haiku');
      expect(body).not.toHaveProperty('commits');
      // Nothing leaks: no upstream body, no token, no commit content.
      expect(res.body).not.toContain('commit secret');
      expect(res.body).not.toContain('ghp_test_operational_failure');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('owner auth on POST /api/owner', () => {
  it('rejects unsigned owner setup with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/owner',
      payload: { githubLogin: 'someone', githubToken: 'ghp_secret123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bogus bearer token with 401', async () => {
    const headers = { authorization: 'Bearer not.a.valid.jwt' };
    const res = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the SAME session JWT on repeated requests (single signature, no re-sign)', async () => {
    // Wallet 2: one sign-in establishes a reusable session. The first POST
    // creates the owner (201); a second request with the SAME bearer token is
    // accepted (200 idempotent) — the JWT is not single-use, unlike the nonce.
    const headers = await authHeaders(2);
    const first = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(second.statusCode).toBe(200);
  });

  it('creates an owner with a valid session and never echoes the token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/owner',
      headers: await authHeaders(3),
      payload: { githubLogin: 'someone', githubToken: 'ghp_secret123' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.secretCode).toMatch(/^[a-z0-9-]+$/);
    expect(body.hasGithubToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain('ghp_secret123');
  });
});

describe('POST /api/reports/last-week', () => {
  it('requires owner auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/reports/last-week' });
    expect(res.statusCode).toBe(401);
  });

  it('returns a last-week activity report without echoing the GitHub token', async () => {
    // Pick a timestamp inside the endpoint's previous complete UTC week window.
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const currentWeekStart = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000);
    const previousWeekStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const commitDate = new Date(previousWeekStart.getTime() + 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000).toISOString();
    const commitFixture = JSON.stringify({
      items: [
        {
          repository: { full_name: 'octocat/hello' },
          commit: { message: 'feat: add weekly report\n\nbody should be ignored', author: { date: commitDate } },
        },
      ],
    });

    const headers = await authHeaders(1);
    const created = await app.inject({
      method: 'POST',
      url: '/api/owner',
      headers,
      payload: { githubLogin: 'octocat', githubToken: 'ghp_report_success' },
    });
    expect(created.statusCode).toBe(201);

    const realFetch = global.fetch;
    global.fetch = (async () => new Response(commitFixture, { status: 200 })) as typeof fetch;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/reports/last-week', headers });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.githubLogin).toBe('octocat');
      expect(body.days).toHaveLength(7);
      expect(body.commitCount).toBe(1);
      expect(body.overview).toContain('1 commit');
      expect(JSON.stringify(body.days)).toContain('hello: feat: add weekly report');
      expect(res.body).not.toContain('ghp_report_success');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('POST /api/reports/last-week/share', () => {
  it('returns a clean denial for an invalid share code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/reports/last-week/share',
      payload: { code: 'wrong-code' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ allowed: false, reason: 'invalid code' });
  });

  it('returns a report for a valid share code without echoing the GitHub token', async () => {
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const currentWeekStart = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000);
    const previousWeekStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const commitDate = new Date(previousWeekStart.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const commitFixture = JSON.stringify({
      items: [
        {
          repository: { full_name: 'octocat/hello' },
          commit: { message: 'feat: share weekly report', author: { date: commitDate } },
        },
      ],
    });
    const owner = createOwner({ githubLogin: 'octocat', githubToken: 'ghp_shared_report' });

    const realFetch = global.fetch;
    global.fetch = (async () => new Response(commitFixture, { status: 200 })) as typeof fetch;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/reports/last-week/share',
        payload: { code: owner.secretCode },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(true);
      expect(body.report.githubLogin).toBe('octocat');
      expect(body.report.days).toHaveLength(7);
      expect(body.report.commitCount).toBe(1);
      expect(JSON.stringify(body.report.days)).toContain('hello: feat: share weekly report');
      expect(res.body).not.toContain('ghp_shared_report');
      expect(res.body).not.toContain(owner.secretCode);
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('code management (create / revoke / rotate)', () => {
  it('lists, creates, rotates and revokes codes — gated by owner auth', async () => {
    // Wallet 4 = this owner.
    const created = await app.inject({
      method: 'POST',
      url: '/api/owner',
      headers: await authHeaders(4),
      payload: { githubLogin: 'codeowner' },
    });
    expect(created.statusCode).toBe(201);
    const firstCode = JSON.parse(created.body).secretCode;

    // The first code works on /api/haiku.
    const h1 = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: firstCode } });
    expect(JSON.parse(h1.body).allowed).toBe(true);

    // Unauthenticated code list is rejected.
    expect((await app.inject({ method: 'GET', url: '/api/codes' })).statusCode).toBe(401);

    // List shows one active code (no hash leaked).
    const list1 = await app.inject({ method: 'GET', url: '/api/codes', headers: await authHeaders(4) });
    expect(JSON.parse(list1.body).codes).toHaveLength(1);
    expect(JSON.parse(list1.body).codes[0]).not.toHaveProperty('hash');
    expect(JSON.parse(list1.body).codes[0].secretCode).toBe(firstCode);

    // Create a second code; both work.
    const create2 = await app.inject({ method: 'POST', url: '/api/codes', headers: await authHeaders(4) });
    const secondCode = JSON.parse(create2.body).secretCode;
    expect(JSON.parse((await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secondCode } })).body).allowed).toBe(true);

    // Revoke the first code; it stops working, the second still works.
    const codes = JSON.parse((await app.inject({ method: 'GET', url: '/api/codes', headers: await authHeaders(4) })).body).codes;
    const firstCodeId = codes[0].codeId;
    await app.inject({ method: 'POST', url: '/api/codes/revoke', headers: await authHeaders(4), payload: { codeId: firstCodeId } });
    expect(JSON.parse((await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: firstCode } })).body).allowed).toBe(false);
    expect(JSON.parse((await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secondCode } })).body).allowed).toBe(true);

    // Rotate: all active codes revoked, a fresh one minted.
    const rotated = JSON.parse((await app.inject({ method: 'POST', url: '/api/codes/rotate', headers: await authHeaders(4) })).body);
    expect(JSON.parse((await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: secondCode } })).body).allowed).toBe(false);
    expect(JSON.parse((await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: rotated.secretCode } })).body).allowed).toBe(true);
  });
});

describe('audit log', () => {
  function allAuditEntries(): Array<{ codeId: string; ownerId: string | null; reason: string }> {
    const path = join(DATA_DIR, 'audit.log.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { codeId: string; ownerId: string | null; reason: string });
  }

  it('records allow/deny entries with NO secrets or commit data', async () => {
    // Wallet 5 = this owner.
    const created = await app.inject({
      method: 'POST',
      url: '/api/owner',
      headers: await authHeaders(5),
      payload: { githubLogin: 'auditowner' },
    });
    const code = JSON.parse(created.body).secretCode;

    await app.inject({ method: 'POST', url: '/api/haiku', payload: { code } }); // allow
    await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: 'nope-nope-nope' } }); // deny (other owner)

    const auditRes = await app.inject({ method: 'GET', url: '/api/audit', headers: await authHeaders(5) });
    expect(auditRes.statusCode).toBe(200);
    const entries = JSON.parse(auditRes.body).entries;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const allow = entries.find((e: { decision: string }) => e.decision === 'allow');
    expect(allow).toBeTruthy();
    // Shape: codeId (hash, not raw), ownerId, ts, decision, reason, policyId.
    expect(allow).toHaveProperty('codeId');
    expect(allow).toHaveProperty('ts');
    expect(allow).toHaveProperty('policyId', 'secret-code-v1');
    // The raw code must NEVER appear; no commit/secret fields.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain('feat:');
    expect(serialized).not.toContain('githubToken');
    for (const e of entries) {
      expect(e).not.toHaveProperty('code');
      expect(e).not.toHaveProperty('githubToken');
      expect(e).not.toHaveProperty('commit');
      expect(e).not.toHaveProperty('message');
    }
  });

  it('rejects unauthenticated audit reads', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
  });

  it('coalesces invalid-code audit records by coarse IP/window instead of guessed code', async () => {
    resetAuditCoalescing();
    const before = allAuditEntries().filter((entry) => entry.reason === 'invalid_code').length;

    await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: 'guess-one' } });
    await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: 'guess-two' } });

    const invalid = allAuditEntries().filter((entry) => entry.reason === 'invalid_code');
    expect(invalid.length - before).toBe(1);
    const latest = invalid.at(-1)!;
    expect(latest.ownerId).toBeNull();
    expect(latest.codeId).toMatch(/^invalid:[0-9a-f]{16}$/);
    expect(latest.codeId).not.toBe(codeIdFor('guess-one'));
    expect(latest.codeId).not.toBe(codeIdFor('guess-two'));
  });
});

describe('POST /api/preview (owner-authed full-pipeline preview)', () => {
  // A valid GitHub commit-search response so a token-bearing owner's preview
  // succeeds (github.ts reads /search/commits -> items[].commit.message).
  const eventsFixture = JSON.stringify({
    items: [
      {
        repository: { full_name: 'octocat/hello' },
        commit: { message: 'feat: preview pipeline', author: { date: new Date().toISOString() } },
      },
    ],
  });

  it('rejects an unauthenticated preview with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/preview' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 (no_owner) when the authed address has no owner record', async () => {
    // Wallet 6 has not created an owner yet.
    const res = await app.inject({ method: 'POST', url: '/api/preview', headers: await authHeaders(6) });
    expect(res.statusCode).toBe(404);
  });

  it('returns a guarded 3-line haiku for the authenticated owner (full pipeline)', async () => {
    // Wallet 6: token-bearing owner so preview runs the real fetch path (mocked).
    const created = await app.inject({
      method: 'POST',
      url: '/api/owner',
      headers: await authHeaders(6),
      payload: { githubLogin: 'octocat', githubToken: 'ghp_preview_success' },
    });
    expect(created.statusCode).toBe(201);

    const realFetch = global.fetch;
    global.fetch = (async () => new Response(eventsFixture, { status: 200 })) as typeof fetch;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/preview', headers: await authHeaders(6) });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.allowed).toBe(true);
      expect(body.haiku.lines).toHaveLength(3);
      expect(body.proof.policy_id).toBe(EGRESS_POLICY_ID);
      // No commit data leaks via the preview.
      expect(body).not.toHaveProperty('commits');
      expect(JSON.stringify(body)).not.toContain('feat:');
      expect(res.body).not.toContain('ghp_preview_success');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('returns a staged guarded denial (github) when a pipeline stage fails, no leak', async () => {
    // Same wallet-6 token owner; force the GitHub fetch to fail -> github stage.
    const realFetch = global.fetch;
    global.fetch = (async () => new Response('upstream leaked commit content', { status: 500 })) as typeof fetch;
    try {
      const res = await app.inject({ method: 'POST', url: '/api/preview', headers: await authHeaders(6) });
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ allowed: false, reason: 'could not read your GitHub activity', stage: 'github' });
      expect(res.body).not.toContain('leaked commit content');
      expect(res.body).not.toContain('ghp_preview_success');
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe('GET /health', () => {
  it('responds with liveness only', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
