import { createHash } from 'node:crypto';

import type { HaikuLines } from '@githaiku/shared';

import { config } from './config';
import type { CommitMeta } from './github';

/**
 * Haiku core.
 *
 * DEFAULT (preview): a DETERMINISTIC template generator. Same commits in -> same
 * haiku out. No Anthropic key needed. This is the path that runs in the preview.
 *
 * DEFERRED (behind GITHAIKU_USE_ANTHROPIC=1): an Anthropic-backed generator that
 * uses the owner's key. Stubbed here as the slot-in seam.
 *
 * Either way, the only thing that ever leaves is exactly three lines of haiku —
 * the output guard enforces that downstream.
 */

export interface HaikuGenerator {
  readonly kind: string;
  generate(commits: CommitMeta[]): Promise<HaikuLines>;
}

// --- Deterministic template generator -------------------------------------

const LINE1 = [
  'old branches whisper',
  'quiet commits gather',
  'morning merge begins',
  'fresh diffs settle in',
  'a hush of new code',
];
const LINE2 = [
  'commit lanterns light the path',
  'history folds into now',
  'small fixes ripple outward',
  'messages drift like spring rain',
  'the log remembers each step',
];
const LINE3 = [
  'spring merges quietly',
  'the main branch exhales',
  'tests turn softly green',
  'work rests for the night',
  'a clean tree at last',
];

/**
 * Pick deterministically from `arr` using a stable hash of the seed.
 */
function pick<T>(arr: readonly T[], seed: string): T {
  const h = createHash('sha256').update(seed).digest();
  const idx = h[0]! % arr.length;
  return arr[idx]!;
}

/**
 * Stable seed derived from commit metadata only. No secrets, no diffs.
 */
function seedFromCommits(commits: CommitMeta[]): string {
  const basis = commits
    .map((c) => `${c.repo}|${c.message}|${c.timestamp}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(basis).digest('hex');
}

class DeterministicHaikuGenerator implements HaikuGenerator {
  readonly kind = 'deterministic';
  async generate(commits: CommitMeta[]): Promise<HaikuLines> {
    const seed = seedFromCommits(commits);
    return [
      pick(LINE1, seed + ':1'),
      pick(LINE2, seed + ':2'),
      pick(LINE3, seed + ':3'),
    ] as const;
  }
}

// --- Anthropic generator (DEFERRED behind a flag) -------------------------

class AnthropicHaikuGenerator implements HaikuGenerator {
  readonly kind = 'anthropic';
  constructor(private readonly apiKey: string | null) {}
  async generate(_commits: CommitMeta[]): Promise<HaikuLines> {
    if (!this.apiKey) {
      throw new Error('GITHAIKU_USE_ANTHROPIC=1 but the owner has no Anthropic key');
    }
    // DEFERRED: real Anthropic call slots in here. Out of scope for the preview.
    throw new Error('Anthropic haiku generation is deferred; run with the deterministic generator (default)');
  }
}

export function makeHaikuGenerator(anthropicKey: string | null): HaikuGenerator {
  if (config.useAnthropic) {
    return new AnthropicHaikuGenerator(anthropicKey);
  }
  return new DeterministicHaikuGenerator();
}
