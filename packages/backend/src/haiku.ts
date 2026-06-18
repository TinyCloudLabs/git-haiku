import { createHash } from 'node:crypto';

import type { HaikuLines } from '@githaiku/shared';

import { config } from './config';
import type { CommitMeta } from './github';
import { RedpillHaikuGenerator } from './redpill';

/**
 * Haiku core.
 *
 * DEFAULT (real path): a RedPill-backed generator (Phala confidential LLM
 * gateway), used whenever REDPILL_API_KEY is set. It sees only bounded commit
 * metadata and returns exactly three haiku lines.
 *
 * FALLBACK (no key): a DETERMINISTIC template generator. Same commits in -> same
 * haiku out. No LLM key needed. This is the path the zero-secret portless
 * preview runs.
 *
 * Selection lives in config.haikuGenerator (redpill if a key is present, else
 * deterministic; force via GITHAIKU_HAIKU_GENERATOR). Either way, the only thing
 * that ever leaves is three lines of haiku — the output guard enforces that
 * downstream.
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

// --- Generator selection --------------------------------------------------

/**
 * Pick the generator from config. RedPill is the real path (default when
 * REDPILL_API_KEY is set); the deterministic template is the no-key fallback.
 * Imported lazily so the deterministic/preview path never pulls in RedPill.
 */
export function makeHaikuGenerator(): HaikuGenerator {
  if (config.haikuGenerator === 'redpill') {
    return new RedpillHaikuGenerator();
  }
  return new DeterministicHaikuGenerator();
}
