import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureLocalTcProfile, resetLocalTcProfile } from '../src/tc-profile';

/**
 * The tc-cli delegated `secrets get` only authenticates the delegate via a
 * persisted LOCAL PROFILE (`authMethod === "local"` + `privateKey`). This test
 * asserts the bootstrap helper writes exactly that, at the path the CLI reads
 * (`<HOME>/.tinycloud/profiles/<profile>/profile.json`).
 */

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Address that viem derives for KEY (account #1 of the standard test mnemonic).
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

afterEach(() => {
  resetLocalTcProfile();
});

describe('ensureLocalTcProfile', () => {
  it('writes a local-key profile.json the CLI branch (A) accepts', () => {
    const { home, profile } = ensureLocalTcProfile(KEY);

    const profilePath = join(home, '.tinycloud', 'profiles', profile, 'profile.json');
    const parsed = JSON.parse(readFileSync(profilePath, 'utf8'));

    // The two load-bearing fields for `ensureAuthenticated` branch (A).
    expect(parsed.authMethod).toBe('local');
    expect(parsed.privateKey).toBe(KEY);

    // Faithful-to-`tc init` fields the CLI reads for context resolution.
    expect(profile).toBe('default');
    expect(parsed.name).toBe('default');
    expect(parsed.address).toBe(ADDRESS);
    expect(parsed.did).toBe(`did:pkh:eip155:1:${ADDRESS}`);

    // OMIT all session / openkey fields.
    expect(parsed.spaceId).toBeUndefined();
    expect(parsed.sessionDid).toBeUndefined();

    // 0600 file mode (key at rest, single-tenant enclave FS).
    expect(statSync(profilePath).mode & 0o777).toBe(0o600);
  });

  it('memoizes: same env returned on repeat calls', () => {
    const first = ensureLocalTcProfile(KEY);
    const second = ensureLocalTcProfile(KEY);
    expect(second.home).toBe(first.home);
  });
});
