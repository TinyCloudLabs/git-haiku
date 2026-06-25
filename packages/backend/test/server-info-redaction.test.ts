import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const identityMock = vi.hoisted(() => ({
  getBackendIdentity: vi.fn(),
}));

process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-server-info-test-'));
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
process.env.GITHAIKU_SECRETS_PROVIDER = 'sdk';

vi.mock('../src/attestation', () => ({
  verifyTeeStartup: vi.fn(async () => {}),
  getAttestation: vi.fn(async () => ({
    dev: true,
    note: 'test stub',
    quote: null,
    event_log: null,
    compose_hash: null,
    app_id: null,
  })),
}));

vi.mock('../src/identity', () => ({
  getBackendIdentity: identityMock.getBackendIdentity,
  withSessionRefresh: vi.fn(async (_node: unknown, fn: () => Promise<unknown>) => fn()),
}));

const { buildServer } = await import('../src/server');

const app = await buildServer();

afterAll(async () => {
  await app.close();
});

describe('GET /api/server-info redaction', () => {
  it('redacts sdk backend identity failures from unauthenticated clients', async () => {
    const raw = 'TinyCloud signIn failed: backend private key leaked at /var/run/tinycloud.sock';
    identityMock.getBackendIdentity.mockRejectedValueOnce(new Error(raw));

    const res = await app.inject({ method: 'GET', url: '/api/server-info' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'unavailable' });
    expect(res.body).not.toContain('TinyCloud signIn failed');
    expect(res.body).not.toContain('private key');
    expect(res.body).not.toContain('/var/run/tinycloud.sock');
  });
});
