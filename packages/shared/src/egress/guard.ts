import Ajv2020 from 'ajv/dist/2020';

import { egressSchema } from './schema';
import { EGRESS_STAGES, type EgressDenialPayload, type EgressPayload, type EgressStage } from './types';

export class OutboundGuardError extends Error {
  constructor() {
    super('Outbound payload rejected');
    this.name = 'OutboundGuardError';
  }
}

const ajv = new Ajv2020({
  allErrors: false,
  strict: true,
  allowUnionTypes: true,
});

const validateOutbound = ajv.compile<EgressPayload>(egressSchema);

function rejectOutboundPayload(): never {
  throw new OutboundGuardError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a plain snapshot containing ONLY the known egress fields.
 *
 * This is the sanitize step: rather than validating the caller's object
 * directly (which could carry extra data riding along via the prototype chain,
 * non-enumerable props, or a future schema laxity), we copy a fixed set of
 * fields into a fresh plain object. Anything not explicitly listed here is
 * dropped before validation ever runs. The snapshot is then validated; only a
 * validated snapshot is ever returned/serialized.
 *
 * If the input is not a record, we return an empty object so validation fails
 * cleanly (no field smuggling, no throwing here — the validate step rejects).
 */
function sanitizeToSnapshot(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }

  if (payload['allowed'] === true) {
    const haiku = isRecord(payload['haiku']) ? payload['haiku'] : undefined;
    const proof = isRecord(payload['proof']) ? payload['proof'] : undefined;
    const rawLines = haiku?.['lines'];
    const lines = Array.isArray(rawLines) ? rawLines.slice() : undefined;

    return {
      allowed: true,
      haiku: { lines },
      proof: proof
        ? {
            policy_id: proof['policy_id'],
            image_digest: proof['image_digest'] ?? null,
            attestation_url: proof['attestation_url'] ?? null,
          }
        : undefined,
    };
  }

  // Denial / error branch: only `allowed: false` + a `reason` string + an
  // optional `stage` from the known enum survive. Any `commits`, `error`,
  // `diff`, secrets, etc. are dropped by omission. `stage` is only carried when
  // it is one of the known stage strings, so it can never smuggle data.
  const snapshot: Record<string, unknown> = {
    allowed: false,
    reason: payload['reason'],
  };
  const rawStage = payload['stage'];
  if (typeof rawStage === 'string' && (EGRESS_STAGES as readonly string[]).includes(rawStage)) {
    snapshot['stage'] = rawStage as EgressStage;
  }
  return snapshot;
}

export function normalizeOutboundError(_error: unknown): EgressDenialPayload {
  return {
    allowed: false,
    reason: 'internal error',
  };
}

/**
 * Sanitize -> validate. Returns a clean, validated plain snapshot.
 *
 * Order matters: we sanitize into a fresh known-shape object FIRST, then
 * Ajv-validates that snapshot. The validated object IS the snapshot, so callers
 * never get back a reference to the original (potentially data-bearing) object.
 */
export function guardOutboundPayload(payload: unknown): EgressPayload {
  const snapshot = sanitizeToSnapshot(payload);

  if (!validateOutbound(snapshot)) {
    rejectOutboundPayload();
  }

  return snapshot as EgressPayload;
}

/**
 * The single egress choke point: sanitize -> validate -> serialize.
 * On any failure, falls back to a redacted denial that is itself guarded, so a
 * malformed/leaky payload can never escape as JSON.
 */
export function serializeGuardedResponse(payload: unknown): string {
  try {
    return JSON.stringify(guardOutboundPayload(payload));
  } catch {
    return JSON.stringify(guardOutboundPayload(normalizeOutboundError(payload)));
  }
}

export const guardOutbound = guardOutboundPayload;
