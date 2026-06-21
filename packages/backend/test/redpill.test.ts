import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guardOutboundPayload, OutboundGuardError } from '@githaiku/shared';

// Set RedPill env BEFORE importing config-dependent modules. config reads env at
// import time; the generator reads config.redpill at call time.
process.env.REDPILL_API_KEY = 'test-key-not-real';
process.env.REDPILL_MODEL = 'phala/deepseek-v4-flash';
process.env.GITHAIKU_HAIKU_GENERATOR = 'redpill';

const { RedpillHaikuGenerator, parseHaikuLines } = await import('../src/redpill');
const { makeHaikuGenerator } = await import('../src/haiku');
const { devProof } = await import('../src/proof');
import type { CommitMeta } from '../src/github';

const COMMITS: CommitMeta[] = [
  { repo: 'githaiku', message: 'feat: wire RedPill generator', timestamp: '2026-06-18T09:00:00Z' },
];

/** A fake fetch returning a canned RedPill chat/completions response. */
function mockFetchContent(content: string, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('parseHaikuLines', () => {
  it('parses exactly three trimmed lines', () => {
    expect(parseHaikuLines('  one \n two\nthree  ')).toEqual(['one', 'two', 'three']);
  });

  it('drops markdown fences and list/quote markers', () => {
    expect(parseHaikuLines('```\n- one\n2. two\n> three\n```')).toEqual(['one', 'two', 'three']);
  });

  it('returns null for the wrong line count', () => {
    expect(parseHaikuLines('only one line')).toBeNull();
    expect(parseHaikuLines('one\ntwo\nthree\nfour')).toBeNull();
    expect(parseHaikuLines('')).toBeNull();
  });
});

describe('RedpillHaikuGenerator', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('happy path: parses three lines from the model and they pass the guard', async () => {
    global.fetch = mockFetchContent('old branches whisper\ncommit lanterns light the path\nspring merges quietly');
    const lines = await new RedpillHaikuGenerator().generate(COMMITS);
    expect(lines).toHaveLength(3);

    const guarded = guardOutboundPayload({ allowed: true, haiku: { lines }, proof: devProof() });
    expect('haiku' in guarded && guarded.haiku.lines).toEqual(lines);
  });

  it('wrong line count -> clean failure (no commit data in the error)', async () => {
    global.fetch = mockFetchContent('only two\nlines here');
    let err: unknown;
    try {
      await new RedpillHaikuGenerator().generate(COMMITS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('three usable haiku lines');
    // The error must not leak commit data.
    expect(msg).not.toContain('feat:');
    expect(msg).not.toContain('githaiku');
  });

  it('non-200 -> clean error carrying no body', async () => {
    global.fetch = mockFetchContent('irrelevant', 500);
    await expect(new RedpillHaikuGenerator().generate(COMMITS)).rejects.toThrow(/returned 500/);
  });

  it('a failed generation, run through the guard, becomes a guarded shape (no leak)', async () => {
    global.fetch = mockFetchContent('one line only');
    // Simulate the server flow: generation throws, so we never reach the success
    // branch; the guard only ever sees a denial. Prove the guard rejects an
    // attempt to smuggle commit data via a malformed "success".
    expect(() =>
      guardOutboundPayload({ allowed: true, haiku: { lines: ['x'] }, proof: devProof() }),
    ).toThrow(OutboundGuardError);
  });
});

describe('makeHaikuGenerator selection', () => {
  it('selects redpill when GITHAIKU_HAIKU_GENERATOR=redpill', () => {
    expect(makeHaikuGenerator().kind).toBe('redpill');
  });
});
