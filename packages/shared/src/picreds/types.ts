/**
 * πCreds — shared types.
 *
 * A πCreds credential proves the AGENT'S CONDUCT while generating a haiku, not
 * just the output shape (that's the egress guard's job). Two independent
 * layers feed it:
 *  - the deterministic inspector (this package): structural pass/fail checks,
 *    no LLM involved.
 *  - the LLM evaluator (packages/backend): semantic judgment over the same
 *    commit metadata + haiku.
 * Keeping the layers' verdicts separate (rather than collapsing to one bit)
 * lets them disagree — the inspector can pass a scope/cap/leak check the
 * evaluator would still flag on semantic grounds, and vice versa.
 */

/** The LLM evaluator's verdict on generation conduct. */
export type PicredsConductVerdict = 'clean' | 'flagged' | 'unaudited';

export const PICREDS_CONDUCT_VALUES: readonly PicredsConductVerdict[] = [
  'clean',
  'flagged',
  'unaudited',
] as const;

/**
 * The minimal πCreds summary carried on the public egress `proof` block.
 * The full inspector/evaluator breakdown lives behind the owner-authed audit
 * endpoint, not here.
 */
export interface PicredsProofSummary {
  readonly credential_hash: string;
  readonly conduct: PicredsConductVerdict;
}

export interface PicredsCheckResult {
  readonly pass: boolean;
  /** Short, human-readable reason. Never carries commit content or secrets. */
  readonly reason: string;
}

export interface PicredsInspectorReport {
  readonly scope_ok: boolean;
  readonly cap_ok: boolean;
  readonly leak_ok: boolean;
  readonly egress_ok: boolean;
  readonly checks: {
    readonly scope: PicredsCheckResult;
    readonly cap: PicredsCheckResult;
    readonly leak: PicredsCheckResult;
    readonly egress: PicredsCheckResult;
  };
}
