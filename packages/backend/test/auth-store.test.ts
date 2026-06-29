import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'githaiku-authstore-test-'));
process.env.GITHAIKU_DATA_DIR = DATA_DIR;

const { nonceStore, verifySIWE, issueSessionToken, verifySessionToken, AuthError } = await import(
  '../src/auth'
);
const store = await import('../src/store');

const ACCT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const JWT_KEY = '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e';

/** Build + sign a SIWE message embedding a fresh address-bound nonce. */
async function siweSignIn(nonce: string): Promise<{ message: string; signature: string }> {
  const message = new SiweMessage({
    domain: 'localhost',
    address: ACCT.address,
    statement: 'Git Haiku owner sign-in',
    uri: 'http://localhost',
    version: '1',
    chainId: 1,
    nonce,
    issuedAt: new Date().toISOString(),
  }).prepareMessage();
  const signature = await ACCT.signMessage({ message });
  return { message, signature };
}

describe('address-bound single-use nonce store', () => {
  it('validates a fresh nonce for its bound address exactly once', () => {
    const nonce = nonceStore.issue(ACCT.address);
    expect(nonceStore.validate(ACCT.address, nonce)).toBe(true);
    // Single-use: a second validation fails (burned).
    expect(nonceStore.validate(ACCT.address, nonce)).toBe(false);
  });

  it('rejects a nonce presented for a different address', () => {
    const nonce = nonceStore.issue(ACCT.address);
    const other = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    expect(nonceStore.validate(other, nonce)).toBe(false);
  });

  it('rejects an unknown nonce', () => {
    expect(nonceStore.validate(ACCT.address, 'deadbeefdeadbeef')).toBe(false);
  });
});

describe('SIWE verification → session JWT', () => {
  it('recovers the signer + nonce from a valid SIWE message', async () => {
    const nonce = nonceStore.issue(ACCT.address);
    const { message, signature } = await siweSignIn(nonce);
    const result = await verifySIWE(message, signature);
    expect(result.address.toLowerCase()).toBe(ACCT.address.toLowerCase());
    expect(result.nonce).toBe(nonce);
  });

  it('rejects a tampered signature', async () => {
    const nonce = nonceStore.issue(ACCT.address);
    const { message } = await siweSignIn(nonce);
    await expect(verifySIWE(message, '0xdeadbeef')).rejects.toBeInstanceOf(AuthError);
  });

  it('issues a JWT that verifies back to the signer address', async () => {
    const { token } = await issueSessionToken(ACCT.address, JWT_KEY);
    const { address } = await verifySessionToken(token, JWT_KEY);
    expect(address).toBe(ACCT.address);
  });

  it('rejects a JWT signed with a different key', async () => {
    const { token } = await issueSessionToken(ACCT.address, JWT_KEY);
    const otherKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    await expect(verifySessionToken(token, otherKey)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a malformed token', async () => {
    await expect(verifySessionToken('not.a.jwt', JWT_KEY)).rejects.toBeInstanceOf(AuthError);
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

  it('stores hashes for validation and plaintext for owner share URLs', () => {
    const onDisk = readFileSync(join(DATA_DIR, 'owners.json'), 'utf8');
    expect(onDisk).toContain(firstCode);
    const data = JSON.parse(onDisk) as { owners: { codes: { hash: string; secretCode: string }[] }[] };
    const owner = data.owners.find(() => true)!;
    expect(owner.codes[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(owner.codes[0]!.secretCode).toBe(firstCode);
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
      if (c.active) expect(c.secretCode).toBeTruthy();
    }
  });
});
