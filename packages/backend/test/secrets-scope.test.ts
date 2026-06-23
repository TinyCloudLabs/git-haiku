import { describe, expect, it, vi } from 'vitest';

/**
 * The tc-cli SecretsProvider must read GITHUB_TOKEN from the SCOPED vault path
 * by passing `--scope githaiku` to `tc secrets get`. We mock execFile and assert
 * the exact argv carries the scope flag (and the secret value round-trips).
 */

process.env.GITHAIKU_SECRETS_PROVIDER = 'tc-cli';
process.env.GITHAIKU_NODE_HOST = 'http://127.0.0.1:9999';

const SECRET_VALUE = 'ghp_scope_test_value';
const capturedArgs: string[][] = [];

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    capturedArgs.push(args);
    cb(null, { stdout: JSON.stringify({ value: SECRET_VALUE }), stderr: '' });
  },
}));

vi.mock('../src/identity', () => ({
  getBackendIdentity: vi.fn(async () => ({
    did: 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222',
    privateKey: '0xabc',
  })),
}));

vi.mock('../src/delegation-store', () => ({
  loadDelegation: vi.fn(async () => ({ serialized: '{"cid":"bafy"}' })),
}));

const { makeSecretsProvider } = await import('../src/secrets');

describe('tc-cli SecretsProvider passes --scope githaiku', () => {
  it('invokes tc secrets get with --scope githaiku and returns the value', async () => {
    const provider = makeSecretsProvider();
    expect(provider.kind).toBe('tc-cli');

    const secrets = await provider.getOwnerSecrets({
      ownerId: 'owner-1',
      githubLogin: 'octocat',
      githubToken: null,
      ownerAddress: '0x1111111111111111111111111111111111111111',
      secretCode: 'code',
    } as never);

    expect(secrets.githubToken).toBe(SECRET_VALUE);

    const getArgs = capturedArgs.find((a) => a.includes('get'));
    expect(getArgs).toBeDefined();
    expect(getArgs).toContain('GITHUB_TOKEN');
    // The load-bearing assertion: --scope githaiku, immediately paired.
    const scopeIdx = getArgs!.indexOf('--scope');
    expect(scopeIdx).toBeGreaterThanOrEqual(0);
    expect(getArgs![scopeIdx + 1]).toBe('githaiku');
  });
});
