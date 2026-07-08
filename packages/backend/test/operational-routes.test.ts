import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-ops-test-'));
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';

vi.mock('../src/attestation', () => ({
  verifyTeeStartup: vi.fn(async () => {}),
  getAttestation: vi.fn(async () => {
    throw new Error('raw dstack socket failure at /var/run/dstack.sock');
  }),
}));

const { buildServer } = await import('../src/server');

const app = await buildServer();

afterAll(async () => {
  await app.close();
});

describe('public operational routes', () => {
  it('/health returns liveness only', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('/info reports deploy provenance (service + version, unauthenticated)', async () => {
    const res = await app.inject({ method: 'GET', url: '/info' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.service).toBe('githaiku-backend');
    expect(typeof body.version).toBe('string');
    // env is 'local' outside a verified TEE (no dstack in the test env).
    expect(body.env).toBe('local');
    // gitSha is omitted when GIT_SHA is unset (local/dev), present in a deploy.
    expect('gitSha' in body).toBe(false);
  });

  it('/api/server-info does not disclose provider state outside sdk mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/server-info' });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(res.body).not.toContain('sdk');
    expect(res.body).not.toContain('local');
  });

  it('/attestation redacts raw attestation failures', async () => {
    const res = await app.inject({ method: 'GET', url: '/attestation' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      error: 'attestation_unavailable',
      message: 'attestation is unavailable',
    });
    expect(res.body).not.toContain('dstack');
    expect(res.body).not.toContain('/var/run/dstack.sock');
  });
});
