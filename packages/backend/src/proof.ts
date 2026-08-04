import { EGRESS_POLICY_ID, type EgressProof, type PicredsProofSummary } from '@githaiku/shared';

import { attestationUrl, imageDigest } from './attestation';

/**
 * Attestation proof carried on every allowed haiku response.
 *
 * IN-TEE: binds to real provenance — `image_digest` = the dstack compose_hash
 * (the measurement of the exact image + env policy running in the CVM) and
 * `attestation_url` = this app's public `/attestation` endpoint, where the full
 * TDX quote can be fetched and verified.
 *
 * LOCAL/DEV: a clearly-marked placeholder (both fields null) that still passes
 * the egress guard, so the zero-secret preview keeps working.
 *
 * `picreds` proves generation CONDUCT (see packages/backend/src/picreds) —
 * the caller (pipeline.ts) computes it from the actual commits/haiku for this
 * request and passes it in; proof.ts only owns the attestation half.
 */
export async function buildProof(picreds: PicredsProofSummary): Promise<EgressProof> {
  return {
    policy_id: EGRESS_POLICY_ID,
    image_digest: await imageDigest(),
    attestation_url: attestationUrl(),
    picreds,
  };
}

/** The clearly-labeled dev placeholder used when no real credential is at hand. */
const DEV_PICREDS_PLACEHOLDER: PicredsProofSummary = {
  credential_hash: `0x${'0'.repeat(64)}`,
  conduct: 'unaudited',
};

/**
 * Dev placeholder proof (image_digest/attestation_url null). Used by tests and
 * any caller that wants the clearly-marked dev shape without touching the
 * attestation path. Accepts an optional real `picreds` summary; defaults to
 * the labeled placeholder.
 */
export function devProof(picreds: PicredsProofSummary = DEV_PICREDS_PLACEHOLDER): EgressProof {
  return { policy_id: EGRESS_POLICY_ID, image_digest: null, attestation_url: null, picreds };
}
