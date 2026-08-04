import type { PicredsCheckResult, PicredsInspectorReport } from './types';

/**
 * πCreds deterministic inspector.
 *
 * Runs on every haiku generation, before the credential is finalized. Pure
 * boolean/structural checks over the SAME commit metadata + haiku lines the
 * generator saw — no LLM call, no network. Mirrors the
 * `check_minimum_rounds`-style hard gates from DealProof: no arbitrary
 * thresholds, caps come from the caller (backend config), not from this
 * module.
 *
 * This is one of two independent layers (see picreds/types.ts) — it does NOT
 * replace the LLM evaluator's semantic judgment, and its checks are kept
 * separate on purpose so the two can disagree.
 */

const ALLOWED_COMMIT_KEYS = new Set(['repo', 'message', 'timestamp']);
const DEFAULT_LEAK_MIN_LENGTH = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PicredsInspectorInput {
  /** Raw commit metadata objects exactly as passed into haiku generation. */
  readonly commits: readonly unknown[];
  /** The haiku lines produced from `commits`. */
  readonly haikuLines: readonly string[];
  /** GITHAIKU_MAX_COMMITS — the configured hard cap on commit count. */
  readonly maxCommits: number;
  /** GITHAIKU_WINDOW_DAYS — the configured hard cap on commit recency. */
  readonly windowDays: number;
  /** Minimum substring length considered by the leak check. Default 8. */
  readonly leakMinLength?: number;
  /** Clock override, for deterministic tests. Defaults to `new Date()`. */
  readonly now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scope check: every commit object passed into generation carries ONLY
 * `message` / `repo` / `timestamp` — never `diff`, `patch`, `files`, or any
 * other file-content-shaped key. Structural key inspection, not a value read,
 * so it works regardless of what those extra fields contain.
 */
function checkScope(commits: readonly unknown[]): PicredsCheckResult {
  for (const commit of commits) {
    if (!isRecord(commit)) {
      return { pass: false, reason: 'a commit entry is not a plain metadata object' };
    }
    const extraKeys = Object.keys(commit).filter((key) => !ALLOWED_COMMIT_KEYS.has(key));
    if (extraKeys.length > 0) {
      return {
        pass: false,
        reason: `commit payload carries fields outside message/repo/timestamp: ${extraKeys.join(', ')}`,
      };
    }
  }
  return { pass: true, reason: 'every commit payload carries only message/repo/timestamp' };
}

/**
 * Cap check: commit count <= maxCommits, and every commit's timestamp falls
 * within the last windowDays (relative to `now`). Mirrors github.ts's own
 * `withinWindow` semantics (lower bound only, so future-dated commits from a
 * clock-skewed source aren't treated as a cap violation).
 */
function checkCap(
  commits: readonly unknown[],
  maxCommits: number,
  windowDays: number,
  now: Date,
): PicredsCheckResult {
  if (commits.length > maxCommits) {
    return { pass: false, reason: `commit count ${commits.length} exceeds the cap of ${maxCommits}` };
  }

  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  for (const commit of commits) {
    const timestamp = isRecord(commit) ? commit['timestamp'] : undefined;
    if (typeof timestamp !== 'string') {
      return { pass: false, reason: 'a commit is missing a string timestamp' };
    }
    const t = new Date(timestamp).getTime();
    if (Number.isNaN(t) || t < cutoff) {
      return { pass: false, reason: `a commit timestamp falls outside the ${windowDays}-day window` };
    }
  }
  return { pass: true, reason: `${commits.length} commit(s), all within the ${windowDays}-day window` };
}

/**
 * Long alphanumeric-ish tokens from `text`, at least `minLength` chars. Deliberately
 * simple (not semantic) — this is the "catches the dumb case cheaply" layer;
 * splitting on non-token characters means URLs, emails, and secret-looking
 * tokens (which tend to be one long unbroken run) survive as single tokens.
 */
function extractLongTokens(text: string, minLength: number): string[] {
  return Array.from(
    new Set(
      text
        .split(/[^A-Za-z0-9@._/:-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= minLength),
    ),
  );
}

/**
 * Leak check: no commit-message substring (>= leakMinLength chars) appears
 * verbatim in the haiku output. Simple substring diff, not semantic — the LLM
 * evaluator covers the semantic case. The reason string deliberately omits the
 * offending token itself (a count only) so this report never becomes a second
 * place for a leaked secret to land.
 */
function checkLeak(
  commits: readonly unknown[],
  haikuLines: readonly string[],
  minLength: number,
): PicredsCheckResult {
  const haikuText = haikuLines.join('\n').toLowerCase();
  let leakedCount = 0;
  for (const commit of commits) {
    const message = isRecord(commit) && typeof commit['message'] === 'string' ? commit['message'] : '';
    for (const token of extractLongTokens(message, minLength)) {
      if (haikuText.includes(token.toLowerCase())) {
        leakedCount += 1;
      }
    }
  }
  return leakedCount === 0
    ? { pass: true, reason: 'no verbatim commit-message substrings found in the haiku' }
    : { pass: false, reason: `${leakedCount} verbatim substring(s) from commit messages found in the haiku` };
}

/**
 * Egress conformance: haiku is exactly 3 non-empty lines. The full shape
 * (schema, proof, etc.) is already enforced by the output guard downstream —
 * this just confirms the haiku itself is well-formed going in.
 */
function checkEgress(haikuLines: readonly string[]): PicredsCheckResult {
  const wellFormed = haikuLines.length === 3 && haikuLines.every((line) => typeof line === 'string' && line.trim().length > 0);
  return wellFormed
    ? { pass: true, reason: 'haiku is exactly three non-empty lines' }
    : { pass: false, reason: 'haiku is not exactly three non-empty lines' };
}

export function inspectGeneration(input: PicredsInspectorInput): PicredsInspectorReport {
  const { commits, haikuLines, maxCommits, windowDays } = input;
  const leakMinLength = input.leakMinLength ?? DEFAULT_LEAK_MIN_LENGTH;
  const now = input.now ?? new Date();

  const scope = checkScope(commits);
  const cap = checkCap(commits, maxCommits, windowDays, now);
  const leak = checkLeak(commits, haikuLines, leakMinLength);
  const egress = checkEgress(haikuLines);

  return {
    scope_ok: scope.pass,
    cap_ok: cap.pass,
    leak_ok: leak.pass,
    egress_ok: egress.pass,
    checks: { scope, cap, leak, egress },
  };
}
