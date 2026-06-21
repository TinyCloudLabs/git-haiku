import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-authstore-test-'));
process.env.GITHAIKU_DATA_DIR = DATA_DIR;

const { buildAuthMessage, nonceStore, verifyOwnerAuth, AuthError } = await import('../src/auth');
const store = await import('../src/store');

const ACCT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

async function sign(): Promise<{ address: string; nonce: string; signature: string }> {
  const nonce = nonceStore.issue();
  const signature = await ACCT.signMessage({ message: buildAuthMessage(nonce) });
  return { address: ACCT.address, nonce, signature };
}

describe('verifyOwnerAuth', () => {
  it('accepts a valid signature over a fresh nonce', async () => {
    const result = await verifyOwnerAuth(await sign());
    expect(result.address.toLowerCase()).toBe(ACCT.address.toLowerCase());
  });

  it('rejects a missing payload', async () => {
    await expect(verifyOwnerAuth({})).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an unknown / unissued nonce', async () => {
    const signature = await ACCT.signMessage({ message: buildAuthMessage('not-a-real-nonce') });
    await expect(
      verifyOwnerAuth({ address: ACCT.address, nonce: 'not-a-real-nonce', signature }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a replayed nonce (single-use)', async () => {
    const auth = await sign();
    await verifyOwnerAuth(auth); // burns it
    await expect(verifyOwnerAuth(auth)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects when the signer does not match the claimed address', async () => {
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const nonce = nonceStore.issue();
    const signature = await other.signMessage({ message: buildAuthMessage(nonce) });
    await expect(verifyOwnerAuth({ address: ACCT.address, nonce, signature })).rejects.toBeInstanceOf(AuthError);
  });
});

describe('secret code management', () => {
  let ownerId: string;
  let firstCode: string;

  beforeAll(() => {
    const created = store.createOwner({ githubLogin: 'codeuser', ownerAddress: ACCT.address });
    ownerId = created.ownerId;
    firstCode = created.secretCode;
  });

  it('only stores HASHES of codes at rest, never plaintext', () => {
    const onDisk = readFileSync(join(DATA_DIR, 'owners.json'), 'utf8');
    expect(onDisk).not.toContain(firstCode);
    // The persisted record exposes a hash + codeId, not the plaintext.
    const data = JSON.parse(onDisk) as { owners: { codes: { hash: string }[] }[] };
    const owner = data.owners.find(() => true)!;
    expect(owner.codes[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates a code constant-time via findOwnerByCode', () => {
    expect(store.findOwnerByCode(firstCode)?.ownerId).toBe(ownerId);
    expect(store.findOwnerByCode('wrong-code')).toBeNull();
  });

  it('creates additional codes; all active codes validate', () => {
    const second = store.createCode(ownerId);
    expect(store.findOwnerByCode(second.secretCode)?.ownerId).toBe(ownerId);
    expect(store.findOwnerByCode(firstCode)?.ownerId).toBe(ownerId);
    expect(store.listCodes(ownerId).filter((c) => c.active)).toHaveLength(2);
  });

  it('revoke disables exactly one code', () => {
    const codes = store.listCodes(ownerId);
    const firstId = codes[0]!.codeId;
    store.revokeCode(ownerId, firstId);
    expect(store.findOwnerByCode(firstCode)).toBeNull();
    expect(store.listCodes(ownerId).find((c) => c.codeId === firstId)!.active).toBe(false);
  });

  it('rotate revokes all active codes and mints a fresh one', () => {
    const rotated = store.rotateCodes(ownerId);
    const active = store.listCodes(ownerId).filter((c) => c.active);
    expect(active).toHaveLength(1);
    expect(active[0]!.codeId).toBe(rotated.codeId);
    expect(store.findOwnerByCode(rotated.secretCode)?.ownerId).toBe(ownerId);
  });

  it('listCodes never exposes hashes', () => {
    for (const c of store.listCodes(ownerId)) {
      expect(c).not.toHaveProperty('hash');
    }
  });
});
