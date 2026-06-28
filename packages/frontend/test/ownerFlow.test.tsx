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
  hasGithubToken,
  verifyGithubToken,
  previewHaiku,
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
  hasGithubToken: vi.fn(async () => false),
  verifyGithubToken: vi.fn(async () => ({
    ok: true as const,
    login: 'octocat',
    scopes: ['repo'],
    canReadRepos: true,
  })),
  previewHaiku: vi.fn(async () => ({
    allowed: true as const,
    haiku: { lines: ['autumn commit lands', 'tests turn green beneath the moon', 'merge into the main'] },
    proof: { policy_id: 'p', image_digest: null, attestation_url: null },
  })),
  signInOwner: vi.fn(async () => ({
    openkey: { address: '0xabc', keyId: 'k', did: 'did:pkh:eip155:1:0xabc', openkey: {}, web3Provider: {} },
    tcw: {},
    did: 'did:pkh:eip155:1:0xabc',
    backendDid: 'did:pkh:eip155:1:0xBACKEND',
    composedRequest: { delegationTargets: [{ did: 'did:pkh:eip155:1:0xBACKEND' }] },
    auth: { address: '0xabc', token: 'jwt-token' },
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
vi.mock('../src/lib/tinycloud', () => ({
  putGithubToken,
  materializeBackendDelegation,
  hasGithubToken,
}));
vi.mock('../src/lib/githubVerify', () => ({ verifyGithubToken }));
vi.mock('../src/api', () => ({
  registerOwner,
  sendDelegation,
  previewHaiku,
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

    // GitHub token help: link to create a fine-grained PAT + permissions hint.
    const tokenLink = screen
      .getAllByRole('link')
      .find((a) => a.getAttribute('href') === 'https://github.com/settings/personal-access-tokens/new');
    expect(tokenLink).toBeTruthy();
    expect(tokenLink!.getAttribute('target')).toBe('_blank');
    expect(tokenLink!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/what permissions\?/i)).toBeTruthy();

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

  it('verifies a valid GitHub token and shows the login + scopes', async () => {
    const user = userEvent.setup();
    render(<OwnerFlow />);
    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));
    await screen.findByText(/what you're authorizing/i);

    await user.type(screen.getByPlaceholderText('ghp_…'), 'ghp_secret_token');
    await user.click(screen.getByRole('button', { name: /verify token/i }));

    expect(verifyGithubToken).toHaveBeenCalledWith('ghp_secret_token');
    await screen.findByText(/valid — authenticated as/i);
    expect(screen.getByText('octocat')).toBeTruthy();
    expect(screen.getByText(/scopes: repo/i)).toBeTruthy();
  });

  it('shows an invalid-token error and blocks storing it', async () => {
    verifyGithubToken.mockResolvedValueOnce({
      ok: false as const,
      status: 401,
      message: 'Invalid token — GitHub rejected it (401).',
    } as never);

    const user = userEvent.setup();
    render(<OwnerFlow />);
    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));
    await screen.findByText(/what you're authorizing/i);

    await user.type(screen.getByPlaceholderText('octocat'), 'octocat');
    await user.type(screen.getByPlaceholderText('ghp_…'), 'bad_token');
    await user.click(screen.getByRole('button', { name: /verify token/i }));

    await screen.findByText(/invalid or insufficient token/i);
    // Submit is blocked while the token is known-invalid.
    const submit = screen.getByRole('button', {
      name: /authorize & generate code/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(putGithubToken).not.toHaveBeenCalled();
  });

  it('shows a stored-token indicator for a returning owner', async () => {
    hasGithubToken.mockResolvedValueOnce(true);
    const user = userEvent.setup();
    render(<OwnerFlow />);
    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));

    await screen.findByText(/a github token is already stored in your vault/i);
    expect(hasGithubToken).toHaveBeenCalled();
  });

  it('previews the haiku end-to-end from the dashboard', async () => {
    const user = userEvent.setup();
    render(<OwnerFlow />);
    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));
    await screen.findByText(/what you're authorizing/i);

    await user.type(screen.getByPlaceholderText('octocat'), 'octocat');
    await user.type(screen.getByPlaceholderText('ghp_…'), 'ghp_secret_token');
    await user.click(screen.getByRole('button', { name: /authorize & generate code/i }));

    await screen.findByText(/owner dashboard/i);
    await user.click(screen.getByRole('button', { name: /preview \/ test haiku/i }));

    expect(previewHaiku).toHaveBeenCalledOnce();
    await screen.findByText(/autumn commit lands/i);
    expect(screen.getByText(/merge into the main/i)).toBeTruthy();
  });

  it('shows a stage-keyed message when preview fails', async () => {
    previewHaiku.mockResolvedValueOnce({
      allowed: false as const,
      reason: 'no token',
      stage: 'secrets',
    } as never);

    const user = userEvent.setup();
    render(<OwnerFlow />);
    await user.click(screen.getByRole('button', { name: /sign in with openkey/i }));
    await screen.findByText(/what you're authorizing/i);

    await user.type(screen.getByPlaceholderText('octocat'), 'octocat');
    await user.type(screen.getByPlaceholderText('ghp_…'), 'ghp_secret_token');
    await user.click(screen.getByRole('button', { name: /authorize & generate code/i }));

    await screen.findByText(/owner dashboard/i);
    await user.click(screen.getByRole('button', { name: /preview \/ test haiku/i }));

    await screen.findByText(/couldn't read your stored token/i);
  });
});
