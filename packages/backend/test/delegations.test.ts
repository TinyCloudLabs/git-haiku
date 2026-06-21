import { describe, expect, it, vi } from 'vitest';

vi.mock('@tinycloud/node-sdk', () => ({
  deserializeDelegation: (serialized: string) => JSON.parse(serialized),
}));

const { validateDelegation } = await import('../src/delegations');

const BACKEND_DID = 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222';

function validDelegation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cid: 'bafydelegation',
    delegateDID: BACKEND_DID,
    expiry: new Date(Date.now() + 60 * 60_000).toISOString(),
    resources: [
      {
        service: 'tinycloud.kv',
        space: 'secrets',
        path: 'vault/secrets/GITHUB_TOKEN',
        actions: ['tinycloud.kv/get'],
      },
      {
        service: 'tinycloud.encryption',
        path: 'urn:tinycloud:encryption:did:pkh:eip155:1:0x1111111111111111111111111111111111111111:default',
        actions: ['tinycloud.encryption/decrypt'],
      },
    ],
    ...overrides,
  });
}

describe('validateDelegation', () => {
  it('accepts a live delegation addressed to the backend DID', () => {
    const validated = validateDelegation(validDelegation(), BACKEND_DID);
    expect(validated.expiresAt).toMatch(/Z$/);
    expect(validated.resources).toHaveLength(2);
  });

  it('rejects a delegation addressed to a different audience', () => {
    expect(() =>
      validateDelegation(
        validDelegation({
          delegateDID: 'did:pkh:eip155:1:0x3333333333333333333333333333333333333333',
        }),
        BACKEND_DID,
      ),
    ).toThrow(/audience/);
  });

  it('rejects expired delegations', () => {
    expect(() =>
      validateDelegation(
        validDelegation({
          expiry: new Date(Date.now() - 60_000).toISOString(),
        }),
        BACKEND_DID,
      ),
    ).toThrow(/expired/);
  });

  it('rejects unparseable delegation expiries', () => {
    expect(() =>
      validateDelegation(
        validDelegation({
          expiry: 'next quarter',
        }),
        BACKEND_DID,
      ),
    ).toThrow(/expiry/);
  });
});
