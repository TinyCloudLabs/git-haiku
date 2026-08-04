import { createHash } from 'node:crypto';

import type { PicredsConductVerdict, PicredsInspectorReport } from '@githaiku/shared';

import type { PicredsEvaluatorResult } from './evaluator';

/**
 * πCreds credential assembly.
 *
 * Combines the deterministic inspector's structural verdict with the LLM
 * evaluator's conduct verdict into one credential object, hashed the same way
 * `image_digest` is: a stable digest over the canonical (sorted-key) JSON of
 * everything except the hash field itself, so re-hashing is reproducible.
 */

export interface PicredsCredential {
  readonly version: 'v1';
  readonly inspector: {
    readonly scope_ok: boolean;
    readonly cap_ok: boolean;
    readonly leak_ok: boolean;
    readonly egress_ok: boolean;
  };
  readonly evaluator: {
    readonly conduct: PicredsConductVerdict;
    readonly reason: string;
  };
  readonly credential_hash: string;
}

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildCredential(
  inspector: PicredsInspectorReport,
  evaluator: PicredsEvaluatorResult,
): PicredsCredential {
  const base = {
    version: 'v1' as const,
    inspector: {
      scope_ok: inspector.scope_ok,
      cap_ok: inspector.cap_ok,
      leak_ok: inspector.leak_ok,
      egress_ok: inspector.egress_ok,
    },
    evaluator: {
      conduct: evaluator.conduct,
      reason: evaluator.reason,
    },
  };
  const credential_hash = `0x${createHash('sha256').update(stableStringify(base)).digest('hex')}`;
  return { ...base, credential_hash };
}
