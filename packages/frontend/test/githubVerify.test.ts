import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyGithubToken } from '../src/lib/githubVerify';

/**
 * The frontend-only GitHub token check hits api.github.com directly. We mock
 * fetch at the global boundary and assert: valid → login + scopes + repo-read;
 * fine-grained → null scopes; 401/403 → clear invalid result.
 */

afterEach(() => vi.restoreAllMocks());

function userResponse(login: string, scopes: string | null) {
  const headers = new Headers();
  if (scopes !== null) headers.set('x-oauth-scopes', scopes);
  return new Response(JSON.stringify({ login }), { status: 200, headers });
}

describe('verifyGithubToken', () => {
  it('returns valid with login, classic scopes, and repo read confirmed', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) return userResponse('octocat', 'repo, read:org');
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await verifyGithubToken('ghp_x');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.login).toBe('octocat');
      expect(res.scopes).toEqual(['repo', 'read:org']);
      expect(res.canReadRepos).toBe(true);
    }
    // Token goes to api.github.com, never relative/backend.
    expect(fetchMock.mock.calls.every((c) => String(c[0]).startsWith('https://api.github.com'))).toBe(
      true,
    );
  });

  it('reports null scopes for a fine-grained token (no scopes header)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) return userResponse('octocat', null);
      return new Response('[]', { status: 403 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await verifyGithubToken('github_pat_x');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.scopes).toBeNull();
      expect(res.canReadRepos).toBe(false);
    }
  });

  it('flags a 401 as invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    const res = await verifyGithubToken('bad');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });

  it('flags a 403 as insufficient/rate-limited', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const res = await verifyGithubToken('limited');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('returns an error without calling fetch when the token is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await verifyGithubToken('   ');
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
