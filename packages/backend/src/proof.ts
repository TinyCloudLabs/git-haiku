import { EGRESS_POLICY_ID, type EgressProof } from '@githaiku/shared';

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
 */
export async function buildProof(): Promise<EgressProof> {
  return {
    policy_id: EGRESS_POLICY_ID,
    image_digest: await imageDigest(),
    attestation_url: attestationUrl(),
  };
}

/**
 * Dev placeholder proof (both fields null). Used by tests and any caller that
 * wants the clearly-marked dev shape without touching the attestation path.
 */
export function devProof(): EgressProof {
  return { policy_id: EGRESS_POLICY_ID, image_digest: null, attestation_url: null };
}
