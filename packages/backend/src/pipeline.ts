import {
  type EgressPayload,
  type EgressStage,
  guardOutboundPayload,
} from '@githaiku/shared';

import { readCachedHaiku, writeCachedHaiku } from './generation-cache';
import { fetchRecentCommits, fingerprintCommits } from './github';
import { makeHaikuGenerator } from './haiku';
import { buildProof } from './proof';
import type { SecretsProvider } from './secrets';
import type { OwnerRecord } from './store';

/**
 * The shared haiku pipeline used by BOTH the requester endpoint (/api/haiku)
 * and the owner-authed preview endpoint (/api/preview).
 *
 * It runs the EXACT same stages for an owner:
 *   1. secrets  — read the owner's GITHUB_TOKEN via the secrets provider
 *      (sdk reads it under the owner's stored delegation).
 *   2. github   — fetch bounded recent commit metadata.
 *   3. generate — render the haiku (RedPill or deterministic).
 * Then it builds the guarded success payload (proof attached).
 *
 * Every outcome is funneled through the egress guard before it leaves this
 * function, so success and staged denials alike are already guard-validated and
 * carry NO commit data or secrets. On a stage failure it returns a guarded
 * denial whose `stage` names the failing step with a generic, non-leaking
 * `reason`, and surfaces the REAL error on `logError` so callers can log it
 * server-side (safe in the attested TEE — never logs secret values or commit
 * contents).
 */

export type PipelineSuccess = {
  ok: true;
  /** Guarded `{ allowed: true, haiku, author, proof }`. */
  payload: EgressPayload;
  /** Machine reason for the audit log. */
  auditReason: string;
};

export type PipelineFailure = {
  ok: false;
  /** Guarded `{ allowed: false, reason, stage? }`. */
  payload: EgressPayload;
  /** Which stage failed (drives the HTTP status the route picks). */
  stage: EgressStage;
  /** HTTP status the route should send. */
  statusCode: number;
  /** Machine reason for the audit log. */
  auditReason: string;
  /**
   * The REAL underlying error, for server-side logging ONLY. Never serialized
   * into the response. `null` for non-error denials (e.g. no recent activity).
   */
  logError: unknown;
};

export type PipelineResult = PipelineSuccess | PipelineFailure;

/** Build a guarded staged denial. The reason is generic; `stage` is diagnostic. */
function denial(
  stage: EgressStage,
  reason: string,
  statusCode: number,
  auditReason: string,
  logError: unknown,
): PipelineFailure {
  return {
    ok: false,
    payload: guardOutboundPayload({ allowed: false, reason, stage }),
    stage,
    statusCode,
    auditReason,
    logError,
  };
}

export async function generateHaikuForOwner(
  owner: OwnerRecord,
  secrets: SecretsProvider,
  options: { force?: boolean } = {},
): Promise<PipelineResult> {
  // 1. secrets — read the owner's GITHUB_TOKEN (sdk: under their delegation).
  let githubToken: string | null;
  try {
    githubToken = (await secrets.getOwnerSecrets(owner)).githubToken;
  } catch (err) {
    return denial('secrets', 'could not read your stored token', 502, 'secrets_error', err);
  }

  // 2. github — fetch bounded recent commit metadata.
  let commits;
  try {
    ({ commits } = await fetchRecentCommits({ githubLogin: owner.githubLogin, githubToken }));
  } catch (err) {
    return denial('github', 'could not read your GitHub activity', 502, 'github_error', err);
  }

  if (commits.length === 0) {
    // Not a stage failure — a clean, expected denial (no stage tag, 200/OK-ish).
    return {
      ok: false,
      payload: guardOutboundPayload({ allowed: false, reason: 'no recent activity' }),
      stage: 'github',
      statusCode: 200,
      auditReason: 'no_recent_activity',
      logError: null,
    };
  }

  const commitFingerprint = fingerprintCommits(commits);
  if (!options.force) {
    const cached = readCachedHaiku(owner.ownerId, commitFingerprint);
    if (cached) {
      return { ok: true, payload: guardOutboundPayload(cached), auditReason: 'cache_hit' };
    }
  }

  // 3. generate — render the haiku.
  let lines;
  try {
    lines = await makeHaikuGenerator().generate(commits);
  } catch (err) {
    return denial('generate', 'could not generate the haiku', 502, 'generate_error', err);
  }

  // Build + guard the success payload with real (in-TEE) provenance.
  try {
    const payload = guardOutboundPayload({
      allowed: true,
      haiku: { lines },
      author: { githubLogin: owner.githubLogin },
      proof: await buildProof(),
    });
    writeCachedHaiku(owner.ownerId, commitFingerprint, payload);
    return { ok: true, payload, auditReason: 'ok' };
  } catch (err) {
    return denial('internal', 'could not generate the haiku', 503, 'internal_error', err);
  }
}
