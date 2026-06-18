import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EGRESS_POLICY_ID } from '@githaiku/shared';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the dev store at a throwaway dir BEFORE importing modules that read config.
process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-test-'));
// These tests assert the deterministic haiku; force it so the suite never makes
// a live RedPill call (e.g. if REDPILL_API_KEY is present in the environment).
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
// Generous rate limit so the functional tests don't trip it; a dedicated test
// re-imports the server with a tiny limit.
process.env.GITHAIKU_HAIKU_RATE_MAX = '1000';

const { buildServer } = await import('../src/server');
const { createOwner } = await import('../src/store');
const { buildAuthMessage } = await import('../src/auth');

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

/** Signed owner-auth HEADERS for a given wallet (default: wallet 0). */
async function authHeaders(keyIndex = 0): Promise<Record<string, string>> {
  const acct = privateKeyToAccount(ANVIL_KEYS[keyIndex]!);
  const res = await app.inject({ method: 'GET', url: '/api/auth/nonce' });
  const { nonce } = JSON.parse(res.body);
  const signature = await acct.signMessage({ message: buildAuthMessage(nonce) });
  return {
    'x-githaiku-address': acct.address,
    'x-githaiku-nonce': nonce,
    'x-githaiku-signature': signature,
  };
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

  it('rejects a bad signature with 401', async () => {
    const headers = { ...(await authHeaders(1)), 'x-githaiku-signature': '0xdeadbeef' };
    const res = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a replayed nonce', async () => {
    // Wallet 2: first request consumes the nonce; reusing it must 401 (replay),
    // not 409 (the address has no owner yet on the first call).
    const headers = await authHeaders(2);
    const first = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', url: '/api/owner', headers, payload: { githubLogin: 'someone' } });
    expect(replay.statusCode).toBe(401);
  });

  it('creates an owner with a valid signature and never echoes the token', async () => {
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
});

describe('GET /health', () => {
  it('responds ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
