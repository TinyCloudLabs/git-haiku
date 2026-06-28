export const POLICY_ID = 'secret-code-v1' as const;
export const EGRESS_POLICY_ID = POLICY_ID;

export type HaikuLines = readonly [string, string, string];

/**
 * Attestation proof.
 *
 * `image_digest` and `attestation_url` are nullable: in the dev preview the TEE
 * is deferred, so they are emitted as `null` (a clearly-marked placeholder). In
 * an attested deployment they bind to the real dstack image digest + attestation
 * URL. This is part of the guarded egress shape, not an error fallback.
 */
export interface EgressProof {
  readonly policy_id: typeof POLICY_ID;
  readonly image_digest: string | null;
  readonly attestation_url: string | null;
}

export interface EgressSuccessPayload {
  readonly allowed: true;
  readonly haiku: {
    readonly lines: HaikuLines;
  };
  readonly proof: EgressProof;
}

/**
 * Which pipeline stage produced a denial. Diagnostic only — it names the step
 * that failed and carries NO commit data or secrets. Omitted on denials that
 * aren't pipeline-stage failures (invalid code, rate limited, no activity).
 */
export type EgressStage = 'code' | 'secrets' | 'github' | 'generate' | 'internal';

export const EGRESS_STAGES: readonly EgressStage[] = [
  'code',
  'secrets',
  'github',
  'generate',
  'internal',
] as const;

export interface EgressDenialPayload {
  readonly allowed: false;
  readonly reason: string;
  readonly stage?: EgressStage;
}

export type EgressErrorPayload = EgressDenialPayload;

export type EgressPayload = EgressSuccessPayload | EgressDenialPayload;
export type EgressFailurePayload = EgressDenialPayload;
