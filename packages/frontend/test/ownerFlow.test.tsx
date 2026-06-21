import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Flow test for the owner setup, with the web-sdk + OpenKey mocked at the lib
 * boundary. Asserts the real wiring: signInOwner → secrets.put(GITHUB_TOKEN) →
 * registerOwner → materialize delegation → sendDelegation, then the dashboard
 * renders with codes + audit.
 */

const {
  putGithubToken,
  materializeBackendDelegation,
  signInOwner,
  registerOwner,
  sendDelegation,
  listCodes,
  getAudit,
  mintCode,
  rotateCodes,
  revokeCode,
} = vi.hoisted(() => ({
  putGithubToken: vi.fn(async () => {}),
  materializeBackendDelegation: vi.fn(async () => 'SERIALIZED_DELEGATION'),
  signInOwner: vi.fn(async () => ({
    openkey: { address: '0xabc', keyId: 'k', did: 'did:pkh:eip155:1:0xabc', openkey: {}, web3Provider: {} },
    tcw: {},
    did: 'did:pkh:eip155:1:0xabc',
    backendDid: 'did:pkh:eip155:1:0xBACKEND',
    composedRequest: { delegationTargets: [{ did: 'did:pkh:eip155:1:0xBACKEND' }] },
    auth: { address: '0xabc', sign: async () => '0xsig' },
  })),
  registerOwner: vi.fn(async () => ({
    ownerId: 'own_1',
    secretCode: 'aaaa-bbbb-cccc-dddd',
    codeId: 'cid1',
    githubLogin: 'octocat',
    hasGithubToken: true,
  })),
  sendDelegation: vi.fn(async () => ({ status: 'active', expiresAt: '2026-09-16T00:00:00Z' })),
  listCodes: vi.fn(async () => [
    { codeId: 'cid1', createdAt: '2026-06-18T00:00:00Z', revokedAt: null, active: true },
  ]),
  getAudit: vi.fn(async () => [
    { codeId: 'cid1', ownerId: 'own_1', ts: '2026-06-18T01:00:00Z', decision: 'allow', reason: 'ok', policyId: 'secret-code-v1' },
  ]),
  mintCode: vi.fn(),
  rotateCodes: vi.fn(),
  revokeCode: vi.fn(),
}));

vi.mock('../src/lib/ownerSession', () => ({ signInOwner }));
vi.mock('../src/lib/tinycloud', () => ({ putGithubToken, materializeBackendDelegation }));
vi.mock('../src/api', () => ({
  registerOwner,
  sendDelegation,
  listCodes,
  getAudit,
  mintCode,
  rotateCodes,
  revokeCode,
}));

import { OwnerFlow } from '../src/components/OwnerFlow';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OwnerFlow', () => {
  it('signs in, puts the secret, delegates, and shows the dashboard', async () => {
    const user = userEvent.setup();
    render(<OwnerFlow />);

    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));

    // Setup phase: consent + form.
    await screen.findByText(/what you're authorizing/i);
    expect(signInOwner).toHaveBeenCalledOnce();

    await user.type(screen.getByPlaceholderText('octocat'), 'octocat');
    await user.type(screen.getByPlaceholderText('ghp_…'), 'ghp_secret_token');
    await user.click(screen.getByRole('button', { name: /authorize & generate code/i }));

    await waitFor(() => expect(putGithubToken).toHaveBeenCalledWith(expect.anything(), 'ghp_secret_token'));
    expect(registerOwner).toHaveBeenCalledWith(expect.anything(), { githubLogin: 'octocat' });
    expect(materializeBackendDelegation).toHaveBeenCalledWith(
      expect.anything(),
      'did:pkh:eip155:1:0xBACKEND',
      expect.anything(),
    );
    expect(sendDelegation).toHaveBeenCalledWith(expect.anything(), {
      ownerId: 'own_1',
      serialized: 'SERIALIZED_DELEGATION',
    });

    // Dashboard renders codes + audit (cid1 appears in both tables).
    await screen.findByText(/owner dashboard/i);
    expect((await screen.findAllByText('cid1')).length).toBeGreaterThan(0);
    await screen.findByText(/aaaa-bbbb-cccc-dddd/);
    expect(await screen.findByText('allow')).toBeTruthy();
  });
});
