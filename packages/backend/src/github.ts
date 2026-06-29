import { config } from './config';

/**
 * GitHub adapter — COMMIT MESSAGES ONLY.
 *
 * Returns only: commit message, repo name, timestamp. NEVER file contents,
 * diffs, patches, or anything else. Hard-capped by count and time window. This
 * is the data-pull boundary from the spec.
 */
export interface CommitMeta {
  repo: string;
  message: string;
  timestamp: string;
}

export interface FetchResult {
  commits: CommitMeta[];
  /** True when the built-in dev fixture was used (no GitHub token present). */
  usedFixture: boolean;
}

/**
 * DEV-ONLY fixture. Used when the owner has no GitHub token so the preview still
 * renders a haiku. This is labeled dev behavior, surfaced in the response meta —
 * not an error fallback.
 */
const DEV_FIXTURE: CommitMeta[] = [
  { repo: 'githaiku', message: 'feat: render haiku from commit metadata', timestamp: '2026-06-15T09:12:00Z' },
  { repo: 'githaiku', message: 'fix: constant-time secret code comparison', timestamp: '2026-06-14T18:40:00Z' },
  { repo: 'githaiku', message: 'refactor: sanitize before validate in egress guard', timestamp: '2026-06-14T11:05:00Z' },
  { repo: 'tinycloud-node', message: 'chore: bump encryption network defaults', timestamp: '2026-06-13T22:18:00Z' },
  { repo: 'js-sdk', message: 'docs: delegated secret read walkthrough', timestamp: '2026-06-12T15:30:00Z' },
  { repo: 'githaiku', message: 'test: cover denial payloads carry no commit data', timestamp: '2026-06-11T08:02:00Z' },
];

function withinWindow(timestamp: string, windowDays: number): boolean {
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return t >= cutoff;
}

function withinRange(timestamp: string, since: Date, until: Date): boolean {
  const t = new Date(timestamp).getTime();
  if (Number.isNaN(t)) return false;
  return t >= since.getTime() && t < until.getTime();
}

interface GithubSearchCommitItem {
  repository?: { full_name?: string };
  commit?: { message?: string; author?: { date?: string } };
}
interface GithubSearchResponse {
  items?: GithubSearchCommitItem[];
}

/**
 * Fetch bounded recent commit metadata for a GitHub user.
 *
 * Uses the commit SEARCH API (`/search/commits?q=author:<login>`), which returns
 * the user's recent commits across all accessible repos with message + repo +
 * date. We deliberately do NOT use `/users/<login>/events`: GitHub omits the
 * `commits` array from PushEvents for organization repos (the payload carries
 * only ref/head/before), so an org-active user shows "no recent activity".
 *
 * Still strictly message + repo + timestamp — never file contents, diffs, or
 * patches. Bounded by maxCommits and windowDays. No token => labeled dev fixture.
 */
export async function fetchRecentCommits(params: {
  githubLogin: string;
  githubToken: string | null;
}): Promise<FetchResult> {
  const { githubLogin, githubToken } = params;
  const { maxCommits, windowDays } = config.github;

  if (!githubToken) {
    return {
      commits: DEV_FIXTURE.filter((c) => withinWindow(c.timestamp, windowDays * 12)).slice(0, maxCommits),
      usedFixture: true,
    };
  }

  const query = encodeURIComponent(`author:${githubLogin}`);
  const res = await fetch(
    `https://api.github.com/search/commits?q=${query}&sort=author-date&order=desc&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'githaiku',
      },
    },
  );

  if (!res.ok) {
    throw new Error(`GitHub commit search failed: ${res.status}`);
  }

  const body = (await res.json()) as GithubSearchResponse;
  const commits: CommitMeta[] = [];

  // Results are author-date desc, so the first in-window maxCommits are newest.
  for (const item of body.items ?? []) {
    const date = item.commit?.author?.date;
    const message = item.commit?.message;
    if (!date || !message) continue;
    if (!withinWindow(date, windowDays)) continue;
    // Strictly message + repo + timestamp. Nothing else.
    commits.push({
      repo: item.repository?.full_name ?? 'unknown',
      message: message.split('\n')[0]!.slice(0, 200),
      timestamp: date,
    });
    if (commits.length >= maxCommits) break;
  }

  return { commits, usedFixture: false };
}

export async function fetchCommitsInRange(params: {
  githubLogin: string;
  githubToken: string | null;
  since: Date;
  until: Date;
  maxCommits?: number;
}): Promise<FetchResult> {
  const { githubLogin, githubToken, since, until } = params;
  const maxCommits = Math.min(params.maxCommits ?? 100, 100);

  if (!githubToken) {
    return {
      commits: DEV_FIXTURE.filter((c) => withinRange(c.timestamp, since, until)).slice(0, maxCommits),
      usedFixture: true,
    };
  }

  const query = encodeURIComponent(`author:${githubLogin}`);
  const res = await fetch(
    `https://api.github.com/search/commits?q=${query}&sort=author-date&order=desc&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'githaiku',
      },
    },
  );

  if (!res.ok) {
    throw new Error(`GitHub commit search failed: ${res.status}`);
  }

  const body = (await res.json()) as GithubSearchResponse;
  const commits: CommitMeta[] = [];

  for (const item of body.items ?? []) {
    const date = item.commit?.author?.date;
    const message = item.commit?.message;
    if (!date || !message) continue;
    if (!withinRange(date, since, until)) continue;
    commits.push({
      repo: item.repository?.full_name ?? 'unknown',
      message: message.split('\n')[0]!.slice(0, 200),
      timestamp: date,
    });
    if (commits.length >= maxCommits) break;
  }

  return { commits, usedFixture: false };
}
