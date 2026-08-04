import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommitMeta } from '../src/github';

/**
 * config.ts reads env at import time and freezes it into a const, so testing
 * both the "REDPILL_API_KEY set" and "not set" branches in one file requires
 * resetting the module graph and re-importing between cases (same pattern
 * tee-startup.test.ts uses for GITHAIKU_TEE).
 */
async function freshEvaluator(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../src/picreds/evaluator');
}

const COMMITS: CommitMeta[] = [
  { repo: 'githaiku', message: 'feat: wire the picreds evaluator', timestamp: '2026-06-18T09:00:00Z' },
];
const HAIKU = ['old branches whisper', 'commit lanterns light the path', 'spring merges quietly'] as const;

function mockFetchContent(content: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

/** A fetch mock that only rejects once its AbortSignal actually fires, like a real aborted request. */
function mockFetchThatRespectsAbort(): typeof fetch {
  return vi.fn((_url: unknown, options?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
}

describe('evaluateGenerationConduct', () => {
  const realFetch = global.fetch;
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('degrades to a labeled "unaudited" when REDPILL_API_KEY is not set (dev mode)', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: undefined });
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
    expect(result.reason).toContain('REDPILL_API_KEY not set');
  });

  it('returns "clean" from a well-formed RedPill verdict', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent(
      JSON.stringify({ conduct: 'clean', reason: 'haiku derived only from commit metadata' }),
    );
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result).toEqual({ conduct: 'clean', reason: 'haiku derived only from commit metadata' });
  });

  it('returns "flagged" from a well-formed RedPill verdict', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent(JSON.stringify({ conduct: 'flagged', reason: 'haiku references unrelated detail' }));
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result).toEqual({ conduct: 'flagged', reason: 'haiku references unrelated detail' });
  });

  it('strips markdown code fences before parsing the verdict', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent('```json\n{"conduct":"clean","reason":"looks fine"}\n```');
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result).toEqual({ conduct: 'clean', reason: 'looks fine' });
  });

  it('degrades to "unaudited" on an unparseable response body (never throws)', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent('not json at all');
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
    expect(result.reason).toContain('unparseable');
  });

  it('degrades to "unaudited" on a response missing a valid conduct value', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent(JSON.stringify({ conduct: 'suspicious', reason: 'not a real verdict' }));
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
  });

  it('degrades to "unaudited" on a non-200 response (never throws)', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent('irrelevant', 500);
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
    expect(result.reason).toContain('500');
  });

  it('degrades to "unaudited" when RedPill is unreachable (network error, never throws)', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = vi.fn(async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
    expect(result.reason).toContain('unreachable');
  });

  it('degrades to "unaudited" on timeout, using the dedicated eval timeout (never throws)', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({
      REDPILL_API_KEY: 'test-key-not-real',
      GITHAIKU_PICREDS_EVAL_TIMEOUT_MS: '10',
    });
    global.fetch = mockFetchThatRespectsAbort();
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.conduct).toBe('unaudited');
    expect(result.reason).toContain('timed out after 10ms');
  });

  it('never leaks commit content into the reason on any failure path', async () => {
    const { evaluateGenerationConduct } = await freshEvaluator({ REDPILL_API_KEY: 'test-key-not-real' });
    global.fetch = mockFetchContent('irrelevant', 500);
    const result = await evaluateGenerationConduct(COMMITS, HAIKU);
    expect(result.reason).not.toContain('feat:');
    expect(result.reason).not.toContain('githaiku');
  });
});
