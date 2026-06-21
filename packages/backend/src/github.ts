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

interface GithubEventCommit {
  message: string;
}
interface GithubEvent {
  type: string;
  created_at: string;
  repo?: { name: string };
  payload?: { commits?: GithubEventCommit[] };
}

/**
 * Fetch bounded recent commit metadata for a GitHub user.
 *
 * Uses the public events API (PushEvents) which exposes commit messages + repo
 * + timestamp without touching repo contents. Bounded by maxCommits and
 * windowDays. If no token is provided, falls back to the labeled dev fixture.
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

  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(githubLogin)}/events?per_page=100`, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'githaiku',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub events fetch failed: ${res.status}`);
  }

  const events = (await res.json()) as GithubEvent[];
  const commits: CommitMeta[] = [];

  for (const ev of events) {
    if (ev.type !== 'PushEvent' || !ev.payload?.commits) continue;
    if (!withinWindow(ev.created_at, windowDays)) continue;
    for (const c of ev.payload.commits) {
      // Strictly message + repo + timestamp. Nothing else.
      commits.push({
        repo: ev.repo?.name ?? 'unknown',
        message: c.message.split('\n')[0]!.slice(0, 200),
        timestamp: ev.created_at,
      });
      if (commits.length >= maxCommits) break;
    }
    if (commits.length >= maxCommits) break;
  }

  return { commits, usedFixture: false };
}
