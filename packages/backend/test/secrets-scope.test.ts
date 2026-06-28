import { describe, expect, it, vi } from 'vitest';

import { resolveSecretPath } from '@tinycloud/node-sdk';

import { GITHUB_TOKEN_SCOPE } from '../src/policy';

/**
 * The sdk SecretsProvider reads GITHUB_TOKEN from the owner's SCOPED vault path
 * under the owner's stored delegation, directly via the node-SDK (listen-style):
 *   useDelegation -> kv.get(scopedPath, { raw, prefix:'' }) -> decryptEnvelope
 *   -> parse `{ value }`.
 * We mock the node-SDK delegated read and assert the provider:
 *  - applies the owner's delegation,
 *  - KV-gets the EXACT scoped path vault/secrets/scoped/githaiku/GITHUB_TOKEN,
 *  - decrypts with the delegation chain CID as the proof, and
 *  - returns the round-tripped plaintext value.
 */

process.env.GITHAIKU_SECRETS_PROVIDER = 'sdk';
process.env.GITHAIKU_NODE_HOST = 'http://127.0.0.1:9999';

const SECRET_VALUE = 'ghp_scope_test_value';
const SCOPED_PATH = resolveSecretPath('GITHUB_TOKEN', {
  scope: GITHUB_TOKEN_SCOPE,
}).permissionPaths.vault;
const DELEGATION_CID = 'bafyDelegationCid';

// The encrypted envelope KV would return (raw bytes -> { data: envelope }).
const ENVELOPE = {
  v: 2,
  networkId: 'urn:tinycloud:encryption:did:pkh:eip155:1:0xowner:default',
  alg: 'tinycloud-network-envelope',
  keyVersion: 1,
  encryptedSymmetricKey: 'AAAA',
  encryptedSymmetricKeyHash: 'hash',
  ciphertext: 'BBBB',
};

// Captured calls so we can assert the exact KV path + decrypt proof.
const kvGetCalls: Array<{ key: string; options: unknown }> = [];
const decryptCalls: Array<{ envelope: unknown; proof: unknown }> = [];

const kv = {
  get: vi.fn(async (key: string, options: unknown) => {
    kvGetCalls.push({ key, options });
    return { ok: true, data: { data: ENVELOPE } };
  }),
};

const access = {
  kv,
  restorable: { delegationCid: DELEGATION_CID },
  delegation: { cid: DELEGATION_CID },
};

const node = {
  useDelegation: vi.fn(async () => access),
  encryption: {
    decryptEnvelope: vi.fn(async (envelope: unknown, proof: unknown) => {
      decryptCalls.push({ envelope, proof });
      return {
        ok: true,
        data: new TextEncoder().encode(JSON.stringify({ value: SECRET_VALUE })),
      };
    }),
  },
};

vi.mock('../src/identity', () => ({
  getBackendIdentity: vi.fn(async () => ({
    node,
    did: 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222',
    host: 'http://127.0.0.1:9999',
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  })),
}));

// The stored delegation carries the multi-resource breakdown (KV-get on the
// scoped path + decrypt), serialized. We mock deserializeDelegation to return
// the structured PortableDelegation directly so the provider can re-scope it.
vi.mock('../src/delegation-store', () => ({
  loadDelegation: vi.fn(async () => ({
    serialized: '{"opaque":"serialized-delegation"}',
  })),
}));

const STORED_DELEGATION = {
  cid: DELEGATION_CID,
  spaceId: 'did:pkh:eip155:1:0xowner:secrets',
  resources: [
    {
      service: 'tinycloud.kv',
      space: 'secrets',
      path: SCOPED_PATH,
      actions: ['tinycloud.kv/get'],
    },
    {
      service: 'tinycloud.encryption',
      path: 'urn:tinycloud:encryption:did:pkh:eip155:1:0xowner:default',
      actions: ['tinycloud.encryption/decrypt'],
    },
  ],
};

vi.mock('@tinycloud/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tinycloud/node-sdk')>();
  return {
    ...actual,
    deserializeDelegation: vi.fn(() => STORED_DELEGATION),
  };
});

const { makeSecretsProvider } = await import('../src/secrets');

describe('sdk SecretsProvider reads the scoped secret under the delegation', () => {
  it('useDelegation -> KV get scoped path -> decryptEnvelope -> value', async () => {
    const provider = makeSecretsProvider();
    expect(provider.kind).toBe('sdk');

    const secrets = await provider.getOwnerSecrets({
      ownerId: 'owner-1',
      githubLogin: 'octocat',
      githubToken: null,
      ownerAddress: '0x1111111111111111111111111111111111111111',
      secretCode: 'code',
    } as never);

    expect(secrets.githubToken).toBe(SECRET_VALUE);

    // Applied the WHOLE owner delegation (NOT narrowed to KV-only). The
    // activation must carry BOTH the KV-get resource AND the encryption/decrypt
    // resource, otherwise the minted activation sub-delegation cannot satisfy
    // the decryptEnvelope proof ("Unauthorized Action").
    expect(node.useDelegation).toHaveBeenCalledTimes(1);
    const delegationArg = node.useDelegation.mock.calls[0][0] as unknown as {
      resources: Array<{ service: string; actions: string[] }>;
    };
    expect(delegationArg).toBe(STORED_DELEGATION);
    const services = delegationArg.resources.map((resource) => resource.service);
    expect(services).toContain('tinycloud.kv');
    expect(services).toContain('tinycloud.encryption');
    const encryptionResource = delegationArg.resources.find(
      (resource) => resource.service === 'tinycloud.encryption',
    );
    expect(encryptionResource?.actions).toEqual(['tinycloud.encryption/decrypt']);

    // KV-got the EXACT scoped vault path with raw bytes + no prefix.
    expect(kvGetCalls).toHaveLength(1);
    expect(kvGetCalls[0].key).toBe(SCOPED_PATH);
    expect(kvGetCalls[0].options).toEqual({ raw: true, prefix: '' });

    // Decrypted the envelope using the delegation chain CID as the proof.
    expect(decryptCalls).toHaveLength(1);
    expect(decryptCalls[0].proof).toEqual({ proofs: [DELEGATION_CID] });
  });
});
