import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Isolated config BEFORE importing the server: a tiny rate limit so we can trip
// it, and a throwaway data dir + forced deterministic generator.
process.env.GITHAIKU_DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-rl-test-'));
process.env.GITHAIKU_HAIKU_GENERATOR = 'deterministic';
process.env.GITHAIKU_HAIKU_RATE_MAX = '3';
process.env.GITHAIKU_HAIKU_RATE_WINDOW = '1 minute';
process.env.GITHAIKU_RATE_LIMIT_MAX_BUCKETS = '5';

const { buildServer } = await import('../src/server');
const { createOwner } = await import('../src/store');
const {
  consumeInvalidHaikuAttempt,
  consumeMatchedOwnerHaikuAttempt,
  getHaikuRateLimitStateForTests,
  resetHaikuRateLimits,
} = await import('../src/rate-limit');

const app = await buildServer();
let code: string;

beforeAll(async () => {
  await app.ready();
  code = createOwner({ githubLogin: 'octocat' }).secretCode;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetHaikuRateLimits();
});

function requestFrom(ip: string): FastifyRequest {
  return { ip } as FastifyRequest;
}

describe('rate limiting on /api/haiku', () => {
  it('429s after the matched owner limit is exceeded', async () => {
    const statuses: number[] = [];
    // 5 requests with the SAME code from the SAME (default) IP -> same key.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code } });
      statuses.push(res.statusCode);
    }
    // First 3 allowed, the rest rate-limited.
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
  });

  it('429s different invalid candidate codes from the same IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: `wrong-${i}` } });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);
  });

  it('temp-bans the IP after invalid brute-force attempts before code lookup succeeds', async () => {
    for (let i = 0; i < 4; i++) {
      await app.inject({ method: 'POST', url: '/api/haiku', payload: { code: `bad-${i}` } });
    }

    const res = await app.inject({ method: 'POST', url: '/api/haiku', payload: { code } });
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ allowed: false, reason: 'rate limited' });
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('evicts expired limiter buckets on access after the rate window passes', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      consumeInvalidHaikuAttempt(requestFrom('203.0.113.10'), 'wrong-one');
      consumeMatchedOwnerHaikuAttempt(requestFrom('203.0.113.10'), 'owner-one');
      expect(getHaikuRateLimitStateForTests()).toMatchObject({
        invalidIpBuckets: 1,
        invalidCodeBuckets: 1,
        matchedOwnerBuckets: 1,
      });

      vi.advanceTimersByTime(60_001);
      consumeInvalidHaikuAttempt(requestFrom('203.0.113.11'), 'wrong-two');
      consumeMatchedOwnerHaikuAttempt(requestFrom('203.0.113.11'), 'owner-two');

      expect(getHaikuRateLimitStateForTests()).toMatchObject({
        invalidIpBuckets: 1,
        invalidCodeBuckets: 1,
        matchedOwnerBuckets: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps limiter bucket maps bounded under many distinct keys', () => {
    for (let i = 0; i < 50; i++) {
      consumeInvalidHaikuAttempt(requestFrom(`198.51.${i}.10`), `wrong-${i}`);
      consumeMatchedOwnerHaikuAttempt(requestFrom(`203.0.${i}.10`), `owner-${i}`);
    }

    const state = getHaikuRateLimitStateForTests();
    expect(state.maxBuckets).toBe(5);
    expect(state.invalidIpBuckets).toBeLessThanOrEqual(state.maxBuckets);
    expect(state.invalidCodeBuckets).toBeLessThanOrEqual(state.maxBuckets);
    expect(state.matchedOwnerBuckets).toBeLessThanOrEqual(state.maxBuckets);
  });
});
