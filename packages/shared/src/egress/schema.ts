import { POLICY_ID } from './types';

/**
 * The single source of truth for the egress shape.
 *
 * Every backend response is built into a plain snapshot and validated against
 * this schema before serialization. `additionalProperties: false` everywhere is
 * the load-bearing guarantee: success carries only `haiku.lines`, the owner's
 * public GitHub login, and proof metadata; denials carry only a short printable
 * `reason` and never commit data.
 */
export const egressSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['allowed', 'haiku', 'author', 'proof'],
      properties: {
        allowed: {
          const: true,
        },
        haiku: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: {
            lines: {
              type: 'array',
              prefixItems: [
                {
                  type: 'string',
                },
                {
                  type: 'string',
                },
                {
                  type: 'string',
                },
              ],
              items: false,
              minItems: 3,
              maxItems: 3,
            },
          },
        },
        author: {
          type: 'object',
          additionalProperties: false,
          required: ['githubLogin'],
          properties: {
            githubLogin: {
              type: 'string',
              minLength: 1,
              maxLength: 39,
              pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$',
            },
          },
        },
        proof: {
          type: 'object',
          additionalProperties: false,
          required: ['policy_id', 'image_digest', 'attestation_url'],
          properties: {
            policy_id: {
              const: POLICY_ID,
            },
            image_digest: {
              type: ['string', 'null'],
              minLength: 1,
            },
            attestation_url: {
              type: ['string', 'null'],
              minLength: 1,
            },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['allowed', 'reason'],
      properties: {
        allowed: {
          const: false,
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          pattern: '^[\\x20-\\x7E]+$',
        },
        // Optional diagnostic. Names which pipeline stage failed; carries no
        // commit data or secrets. Only valid on the denial branch.
        stage: {
          type: 'string',
          enum: ['code', 'secrets', 'github', 'generate', 'internal'],
        },
      },
    },
  ],
} as const;

export default egressSchema;
