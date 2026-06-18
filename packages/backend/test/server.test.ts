import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EGRESS_POLICY_ID } from '@githaiku/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point the dev store at a throwaway dir BEFORE importing modules that read config.
process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-test-'));
// These tests assert the deterministic haiku; force it so the suite never makes
// a live RedPill call (e.g. if REDPILL_API_KEY is present in the environment).
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';

const { buildServer } = await import('../src/server');
const { createOwner } = await import('../src/store');

const app = buildServer();
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/haiku',
      payload: { code: secretCode },
    });
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/haiku',
      payload: { code: 'totally-wrong-code' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ allowed: false, reason: 'invalid code' });
    expect(body).not.toHaveProperty('haiku');
    expect(body).not.toHaveProperty('commits');
  });

  it('returns a clean denial for a missing code', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: {} });
    const body = JSON.parse(res.body);
    expect(body).toEqual({ allowed: false, reason: 'invalid code' });
  });
});

describe('POST /api/owner', () => {
  it('creates an owner and returns a secret code (never echoes the token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/owner',
      payload: { githubLogin: 'someone', githubToken: 'ghp_secret123' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.secretCode).toMatch(/^[a-z0-9-]+$/);
    expect(body.hasGithubToken).toBe(true);
    // The token value must never come back in the response.
    expect(JSON.stringify(body)).not.toContain('ghp_secret123');
  });

  it('rejects owner setup with no githubLogin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/owner', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /health', () => {
  it('responds ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
