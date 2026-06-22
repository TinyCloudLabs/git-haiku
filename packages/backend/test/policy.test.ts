import { describe, expect, it } from 'vitest';

import { resolveSecretPath } from '@tinycloud/node-sdk';

import { GITHUB_TOKEN_SCOPE, backendPolicy, secretVaultPath } from '../src/policy';

/**
 * The owner's GITHUB_TOKEN is namespaced under the `githaiku` scope, so the
 * backend advertises (and the owner delegates) KV-get on the SCOPED vault path
 * `vault/secrets/scoped/githaiku/GITHUB_TOKEN`. This path is derived via the
 * SDK's `resolveSecretPath`, so it provably matches frontend manifest resolution.
 */
const SCOPED_PATH = 'vault/secrets/scoped/githaiku/GITHUB_TOKEN';

describe('secretVaultPath (scoped)', () => {
  it('uses the canonical githaiku scope', () => {
    expect(GITHUB_TOKEN_SCOPE).toBe('githaiku');
  });

  it('resolves GITHUB_TOKEN to the scoped vault path', () => {
    expect(secretVaultPath('GITHUB_TOKEN')).toBe(SCOPED_PATH);
  });

  it('matches the SDK resolveSecretPath output exactly (frontend/backend parity)', () => {
    const fromSdk = resolveSecretPath('GITHUB_TOKEN', { scope: GITHUB_TOKEN_SCOPE })
      .permissionPaths.vault;
    expect(secretVaultPath('GITHUB_TOKEN')).toBe(fromSdk);
  });

  it('is never the unscoped global path', () => {
    expect(secretVaultPath('GITHUB_TOKEN')).not.toBe('vault/secrets/GITHUB_TOKEN');
  });
});

describe('backendPolicy advertises the scoped KV-get path', () => {
  it('the KV permission targets the scoped path with get only', () => {
    const kv = backendPolicy().find((p) => p.service === 'tinycloud.kv');
    expect(kv).toBeDefined();
    expect(kv!.path).toBe(SCOPED_PATH);
    expect(kv!.actions).toEqual(['get']);
    expect(kv!.skipPrefix).toBe(true);
  });
});
