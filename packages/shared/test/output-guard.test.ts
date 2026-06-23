import { describe, expect, it } from 'vitest';

import { EGRESS_POLICY_ID, type EgressPayload } from '../src/egress';
import {
  guardOutboundPayload,
  normalizeOutboundError,
  OutboundGuardError,
  serializeGuardedResponse,
} from '../src/output-guard';

const validSuccess: EgressPayload = {
  allowed: true,
  haiku: {
    lines: ['old branches whisper', 'commit lanterns light the path', 'spring merges quietly'],
  },
  proof: {
    policy_id: EGRESS_POLICY_ID,
    image_digest: 'sha256:0123456789abcdef',
    attestation_url: 'https://attest.example/githaiku',
  },
};

describe('guardOutbound', () => {
  it('accepts a valid success payload', () => {
    expect(guardOutboundPayload(validSuccess)).toEqual(validSuccess);
  });

  it('strips extra data-bearing fields from success payloads (sanitize first)', () => {
    const guarded = guardOutboundPayload({
      ...validSuccess,
      commits: [{ message: 'secret commit message' }],
    });
    expect(guarded).toEqual(validSuccess);
    expect(guarded).not.toHaveProperty('commits');
  });

  it('rejects malformed haiku shapes', () => {
    expect(() =>
      guardOutboundPayload({
        ...validSuccess,
        haiku: {
          lines: ['too few', 'lines'],
        },
      }),
    ).toThrow(OutboundGuardError);

    expect(() =>
      guardOutboundPayload({
        ...validSuccess,
        haiku: {
          lines: ['one', 'two', 3 as unknown as string],
        },
      }),
    ).toThrow(OutboundGuardError);
  });

  it('rejects success payloads with the wrong proof policy id', () => {
    expect(() =>
      guardOutboundPayload({
        ...validSuccess,
        proof: {
          ...validSuccess.proof,
          policy_id: 'another-policy' as typeof EGRESS_POLICY_ID,
        },
      }),
    ).toThrow(OutboundGuardError);
  });

  it('strips smuggled commit data from denial payloads, keeping only the reason', () => {
    const guarded = guardOutboundPayload({
      allowed: false,
      reason: 'nope',
      commits: [
        {
          message: 'secret commit',
          diff: '+++ hidden',
        },
      ],
    });
    expect(guarded).toEqual({ allowed: false, reason: 'nope' });
    expect(guarded).not.toHaveProperty('commits');
  });

  it('strips smuggled error/secret details from denial payloads', () => {
    const guarded = guardOutboundPayload({
      allowed: false,
      reason: 'internal error',
      error: {
        message: 'leak commit abc123',
        secret: 'super-secret',
      },
    });
    expect(guarded).toEqual({ allowed: false, reason: 'internal error' });
    expect(guarded).not.toHaveProperty('error');
  });

  it('keeps a valid `stage` on denial payloads (diagnostic, no data)', () => {
    const guarded = guardOutboundPayload({
      allowed: false,
      reason: 'could not read your stored token',
      stage: 'secrets',
    });
    expect(guarded).toEqual({ allowed: false, reason: 'could not read your stored token', stage: 'secrets' });
  });

  it('accepts denials with each known stage value', () => {
    for (const stage of ['code', 'secrets', 'github', 'generate', 'internal'] as const) {
      const guarded = guardOutboundPayload({ allowed: false, reason: 'nope', stage });
      expect(guarded).toEqual({ allowed: false, reason: 'nope', stage });
    }
  });

  it('drops an unknown `stage` value rather than leaking it', () => {
    const guarded = guardOutboundPayload({
      allowed: false,
      reason: 'nope',
      stage: 'leaky-commit-data' as unknown as 'secrets',
    });
    expect(guarded).toEqual({ allowed: false, reason: 'nope' });
    expect(guarded).not.toHaveProperty('stage');
  });

  it('omits `stage` when not provided', () => {
    const guarded = guardOutboundPayload({ allowed: false, reason: 'invalid code' });
    expect(guarded).toEqual({ allowed: false, reason: 'invalid code' });
    expect(guarded).not.toHaveProperty('stage');
  });

  it('never accepts `stage` on a success-with-data payload', () => {
    expect(() =>
      guardOutboundPayload({
        ...validSuccess,
        stage: 'generate',
      }),
    ).not.toThrow();
    // The sanitizer drops it from the success snapshot; success never carries stage.
    const guarded = guardOutboundPayload({ ...validSuccess, stage: 'generate' });
    expect(guarded).toEqual(validSuccess);
    expect(guarded).not.toHaveProperty('stage');
  });

  it('rejects denial reasons that are not short printable strings', () => {
    expect(() =>
      guardOutboundPayload({
        allowed: false,
        reason: 'contains\nnewline',
      }),
    ).toThrow(OutboundGuardError);
  });

  it('serializes guarded payloads through the choke point', () => {
    expect(serializeGuardedResponse(validSuccess)).toBe(JSON.stringify(validSuccess));
  });

  it('serializes invalid payloads as redacted denials', () => {
    expect(serializeGuardedResponse(new Error('leak commit abc123'))).toBe(
      JSON.stringify({
        allowed: false,
        reason: 'internal error',
      }),
    );
  });
});

describe('normalizeOutboundError', () => {
  it('redacts error details before egress', () => {
    expect(normalizeOutboundError(new Error('leak commit abc123'))).toEqual({
      allowed: false,
      reason: 'internal error',
    });
  });
});

describe('sanitize-before-validate (dev placeholder + snapshot identity)', () => {
  it('accepts the dev placeholder proof (null image_digest / attestation_url)', () => {
    const devPlaceholder: EgressPayload = {
      allowed: true,
      haiku: {
        lines: ['old branches whisper', 'commit lanterns light the path', 'spring merges quietly'],
      },
      proof: {
        policy_id: EGRESS_POLICY_ID,
        image_digest: null,
        attestation_url: null,
      },
    };
    expect(guardOutboundPayload(devPlaceholder)).toEqual(devPlaceholder);
  });

  it('returns a fresh snapshot, not the original object reference', () => {
    const guarded = guardOutboundPayload(validSuccess);
    expect(guarded).not.toBe(validSuccess);
    expect(guarded).toEqual(validSuccess);
  });

  it('rejects non-record inputs (e.g. arrays, strings) without leaking', () => {
    expect(() => guardOutboundPayload(['x'])).toThrow(OutboundGuardError);
    expect(() => guardOutboundPayload('haiku')).toThrow(OutboundGuardError);
  });
});
