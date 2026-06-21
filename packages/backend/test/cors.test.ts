import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-cors-test-'));
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
process.env.GITHAIKU_ALLOWED_ORIGINS = 'https://app.example,https://admin.example';

const { buildServer } = await import('../src/server');

const app = await buildServer();

afterAll(async () => {
  await app.close();
});

describe('CORS configuration', () => {
  it('allows only configured origins when GITHAIKU_ALLOWED_ORIGINS is set', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.example' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example');

    const blocked = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});
