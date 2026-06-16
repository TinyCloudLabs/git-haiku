import { EGRESS_POLICY_ID, type EgressProof } from '@githaiku/shared';

/**
 * Attestation proof.
 *
 * DEV PLACEHOLDER: the dstack TEE / attestation is deferred, so image_digest and
 * attestation_url are null. This is a clearly-marked placeholder that still
 * passes the egress guard. In an attested deployment these bind to the real
 * image digest + attestation URL returned by /attestation.
 */
export function devProof(): EgressProof {
  return {
    policy_id: EGRESS_POLICY_ID,
    image_digest: null,
    attestation_url: null,
  };
}
