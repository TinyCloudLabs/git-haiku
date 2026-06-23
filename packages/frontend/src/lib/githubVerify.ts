/**
 * Frontend-only GitHub token check.
 *
 * Calls api.github.com directly from the browser (it serves CORS for
 * authenticated requests) so the owner can confirm a token works BEFORE it is
 * encrypted into their vault. The token never touches the Git Haiku backend or
 * any log — it goes straight to GitHub over TLS and the result is discarded.
 */

export interface GithubTokenValid {
  ok: true;
  /** The authenticated account's login. */
  login: string;
  /**
   * Classic-token scopes from the `x-oauth-scopes` header (empty array = the
   * header was present but blank). `null` means the header was absent, which is
   * expected for fine-grained tokens — they don't advertise scopes.
   */
  scopes: string[] | null;
  /** Whether `GET /user/repos?per_page=1` succeeded (best-effort read check). */
  canReadRepos: boolean;
}

export interface GithubTokenInvalid {
  ok: false;
  /** HTTP status from `GET /user` (0 if the request itself threw). */
  status: number;
  /** Human-readable reason for the UI. */
  message: string;
}

export type GithubTokenResult = GithubTokenValid | GithubTokenInvalid;

const GITHUB_API = 'https://api.github.com';

function authHeader(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Verify a GitHub token against `GET /user`. On success, also best-effort checks
 * repo read access via `GET /user/repos?per_page=1`. Returns a discriminated
 * result; never throws on an HTTP error (only the caller's UI decides).
 */
export async function verifyGithubToken(token: string): Promise<GithubTokenResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, status: 0, message: 'Enter a token first.' };
  }

  let userRes: Response;
  try {
    userRes = await fetch(`${GITHUB_API}/user`, { headers: authHeader(trimmed) });
  } catch {
    return {
      ok: false,
      status: 0,
      message: 'Could not reach GitHub. Check your connection and try again.',
    };
  }

  if (userRes.status === 401) {
    return { ok: false, status: 401, message: 'Invalid token — GitHub rejected it (401).' };
  }
  if (userRes.status === 403) {
    return {
      ok: false,
      status: 403,
      message: 'Token lacks permission or is rate-limited (403).',
    };
  }
  if (!userRes.ok) {
    return { ok: false, status: userRes.status, message: `GitHub returned ${userRes.status}.` };
  }

  const user = (await userRes.json().catch(() => ({}))) as { login?: string };
  const login = user.login ?? '(unknown)';

  // `x-oauth-scopes` is only set for classic tokens. Absent header → null
  // (fine-grained token). Present-but-empty → [].
  const scopesHeader = userRes.headers.get('x-oauth-scopes');
  const scopes =
    scopesHeader === null
      ? null
      : scopesHeader
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  let canReadRepos = false;
  try {
    const reposRes = await fetch(`${GITHUB_API}/user/repos?per_page=1`, {
      headers: authHeader(trimmed),
    });
    canReadRepos = reposRes.ok;
  } catch {
    canReadRepos = false;
  }

  return { ok: true, login, scopes, canReadRepos };
}
