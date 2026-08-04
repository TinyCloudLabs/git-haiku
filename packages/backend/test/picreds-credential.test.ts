import { describe, expect, it } from 'vitest';

import type { PicredsInspectorReport } from '@githaiku/shared';

import { buildCredential } from '../src/picreds/credential';
import type { PicredsEvaluatorResult } from '../src/picreds/evaluator';

function report(overrides: Partial<Record<'scope_ok' | 'cap_ok' | 'leak_ok' | 'egress_ok', boolean>> = {}): PicredsInspectorReport {
  const base = { scope_ok: true, cap_ok: true, leak_ok: true, egress_ok: true, ...overrides };
  return {
    ...base,
    checks: {
      scope: { pass: base.scope_ok, reason: 'ok' },
      cap: { pass: base.cap_ok, reason: 'ok' },
      leak: { pass: base.leak_ok, reason: 'ok' },
      egress: { pass: base.egress_ok, reason: 'ok' },
    },
  };
}

const CLEAN_EVALUATOR: PicredsEvaluatorResult = { conduct: 'clean', reason: 'haiku derived only from commit metadata' };

describe('buildCredential', () => {
  it('produces a well-formed credential hash', () => {
    const credential = buildCredential(report(), CLEAN_EVALUATOR);
    expect(credential.credential_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(credential.version).toBe('v1');
    expect(credential.inspector).toEqual({ scope_ok: true, cap_ok: true, leak_ok: true, egress_ok: true });
    expect(credential.evaluator).toEqual(CLEAN_EVALUATOR);
  });

  it('is deterministic: same inspector + evaluator input -> same hash', () => {
    const a = buildCredential(report(), CLEAN_EVALUATOR);
    const b = buildCredential(report(), { ...CLEAN_EVALUATOR });
    expect(a.credential_hash).toBe(b.credential_hash);
  });

  it('changes the hash when any inspector check flips', () => {
    const clean = buildCredential(report(), CLEAN_EVALUATOR);
    const leaked = buildCredential(report({ leak_ok: false }), CLEAN_EVALUATOR);
    expect(leaked.credential_hash).not.toBe(clean.credential_hash);
  });

  it('changes the hash when the evaluator verdict changes', () => {
    const clean = buildCredential(report(), CLEAN_EVALUATOR);
    const flagged = buildCredential(report(), { conduct: 'flagged', reason: 'looks off' });
    expect(flagged.credential_hash).not.toBe(clean.credential_hash);
  });

  it('changes the hash when only the evaluator reason text changes', () => {
    const a = buildCredential(report(), { conduct: 'clean', reason: 'reason A' });
    const b = buildCredential(report(), { conduct: 'clean', reason: 'reason B' });
    expect(a.credential_hash).not.toBe(b.credential_hash);
  });

  it('never includes commit content — only structural booleans + verdict/reason', () => {
    const credential = buildCredential(report(), CLEAN_EVALUATOR);
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain('diff');
    expect(serialized).not.toContain('patch');
  });
});
