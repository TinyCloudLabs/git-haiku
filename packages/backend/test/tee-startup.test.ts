import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const dstack = vi.hoisted(() => ({
  getKey: vi.fn(),
  getQuote: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@phala/dstack-sdk', () => ({
  DstackClient: vi.fn(() => ({
    getKey: dstack.getKey,
    getQuote: dstack.getQuote,
    info: dstack.info,
  })),
}));

function resetEnv(): void {
  delete process.env.GITHAIKU_TEE;
  delete process.env.DSTACK_SIMULATOR_ENDPOINT;
  delete process.env.GITHAIKU_ALLOWED_ORIGINS;
  delete process.env.GITHAIKU_PUBLIC_URL;
  process.env.NODE_ENV = 'test';
}

async function importFreshServer(): Promise<typeof import('../src/server')> {
  vi.resetModules();
  process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-tee-test-'));
  process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
  process.env.GITHAIKU_ALLOWED_ORIGINS = 'https://app.example';
  return import('../src/server');
}

afterEach(() => {
  dstack.getKey.mockReset();
  dstack.getQuote.mockReset();
  dstack.info.mockReset();
  resetEnv();
  vi.resetModules();
});

describe('TEE startup verification', () => {
  it('fails startup in production mode when no dstack socket is reachable', async () => {
    process.env.NODE_ENV = 'production';
    const { buildServer } = await importFreshServer();
    await expect(buildServer()).rejects.toThrow(/dstack socket/i);
  });

  it('verifies dstack key derivation, quote, and info before serving real proofs', async () => {
    process.env.GITHAIKU_TEE = '1';
    process.env.DSTACK_SIMULATOR_ENDPOINT = 'mock://dstack';
    process.env.GITHAIKU_PUBLIC_URL = 'https://api.example';
    dstack.getKey.mockResolvedValue({ key: new Uint8Array([1, 2, 3, 4]) });
    dstack.getQuote.mockResolvedValue({ quote: '0xquote', event_log: 'event-log' });
    dstack.info.mockResolvedValue({
      compose_hash: 'compose-hash',
      app_id: 'app-id',
      instance_id: 'instance-id',
      os_image_hash: 'os-image-hash',
    });

    const { buildServer } = await importFreshServer();
    const app = await buildServer();
    const { buildProof } = await import('../src/proof');

    expect(dstack.getKey).toHaveBeenCalledWith('githaiku/keys/backend', 'backend');
    expect(dstack.getQuote).toHaveBeenCalledOnce();
    expect(dstack.info).toHaveBeenCalledOnce();
    await expect(buildProof()).resolves.toEqual({
      policy_id: 'secret-code-v1',
      image_digest: 'compose-hash',
      attestation_url: 'https://api.example/attestation',
    });

    const attestation = await app.inject({ method: 'GET', url: '/attestation' });
    expect(JSON.parse(attestation.body)).toMatchObject({ dev: false, quote: '0xquote' });
    await app.close();
  });

  it('does not mark TEE capability verified when quote fails', async () => {
    process.env.GITHAIKU_TEE = '1';
    process.env.DSTACK_SIMULATOR_ENDPOINT = 'mock://dstack';
    dstack.getKey.mockResolvedValue({ key: new Uint8Array([9, 9, 9]) });
    dstack.getQuote.mockRejectedValue(new Error('quote failed'));
    dstack.info.mockResolvedValue({ compose_hash: 'compose-hash' });

    const { buildServer } = await importFreshServer();
    await expect(buildServer()).rejects.toThrow(/quote failed/);

    const { inTee } = await import('../src/tee');
    expect(inTee()).toBe(false);
  });
});
