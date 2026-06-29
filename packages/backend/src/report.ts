import { config } from './config';
import { fetchCommitsInRange, type CommitMeta } from './github';
import type { SecretsProvider } from './secrets';
import type { OwnerRecord } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WeeklyReportDay {
  date: string;
  weekday: string;
  commitCount: number;
  repos: string[];
  summary: string;
  highlights: string[];
}

export interface WeeklyReport {
  githubLogin: string;
  generatedAt: string;
  range: { start: string; end: string };
  commitCount: number;
  generatedBy: 'redpill-agent' | 'deterministic';
  overview: string;
  days: WeeklyReportDay[];
}

interface ReportDraft {
  overview: string;
  days: Array<{ date: string; summary: string; highlights: string[] }>;
}

export async function generateLastWeekReportForOwner(
  owner: OwnerRecord,
  secrets: SecretsProvider,
  now = new Date(),
): Promise<WeeklyReport> {
  const { start, end, days } = lastCompleteUtcWeek(now);
  const githubToken = (await secrets.getOwnerSecrets(owner)).githubToken;
  const { commits } = await fetchCommitsInRange({
    githubLogin: owner.githubLogin,
    githubToken,
    since: start,
    until: end,
    maxCommits: 100,
  });

  return buildWeeklyReport({
    githubLogin: owner.githubLogin,
    commits,
    start,
    end,
    days,
    generatedAt: now,
  });
}

export function lastCompleteUtcWeek(now = new Date()): {
  start: Date;
  end: Date;
  days: string[];
} {
  const end = startOfUtcWeek(now);
  const start = new Date(end.getTime() - 7 * DAY_MS);
  const days: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    days.push(toDateKey(new Date(t)));
  }
  return { start, end, days };
}

export async function buildWeeklyReport(input: {
  githubLogin: string;
  commits: CommitMeta[];
  start: Date;
  end: Date;
  days: string[];
  generatedAt: Date;
}): Promise<WeeklyReport> {
  const base = deterministicReport(input);
  if (config.haikuGenerator !== 'redpill' || !config.redpill.apiKey) {
    return base;
  }

  const draft = await generateAgentDraft(input);
  return mergeDraft(base, draft);
}

function deterministicReport(input: {
  githubLogin: string;
  commits: CommitMeta[];
  start: Date;
  end: Date;
  days: string[];
  generatedAt: Date;
}): WeeklyReport {
  const grouped = groupByDay(input.commits);
  const repos = topRepos(input.commits);
  const overview =
    input.commits.length === 0
      ? 'No commits were found for the last complete week.'
      : `You made ${input.commits.length} commit${input.commits.length === 1 ? '' : 's'} across ${
          repos.length
        } repositor${repos.length === 1 ? 'y' : 'ies'}, with most activity in ${repos.slice(0, 3).join(', ')}.`;

  return {
    githubLogin: input.githubLogin,
    generatedAt: input.generatedAt.toISOString(),
    range: { start: toDateKey(input.start), end: toDateKey(new Date(input.end.getTime() - DAY_MS)) },
    commitCount: input.commits.length,
    generatedBy: 'deterministic',
    overview,
    days: input.days.map((date) => {
      const commits = grouped.get(date) ?? [];
      const dayRepos = topRepos(commits);
      return {
        date,
        weekday: weekday(date),
        commitCount: commits.length,
        repos: dayRepos,
        summary:
          commits.length === 0
            ? 'No commits found.'
            : `Worked on ${dayRepos.join(', ')} with ${commits.length} commit${
                commits.length === 1 ? '' : 's'
              }.`,
        highlights: commits.slice(0, 5).map((c) => `${shortRepo(c.repo)}: ${clean(c.message, 140)}`),
      };
    }),
  };
}

async function generateAgentDraft(input: {
  githubLogin: string;
  commits: CommitMeta[];
  days: string[];
}): Promise<ReportDraft> {
  const { baseUrl, model, apiKey, timeoutMs } = config.redpill;
  if (!apiKey) throw new Error('RedPill report selected but REDPILL_API_KEY is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You write concise weekly engineering activity reports. Return ONLY compact JSON. ' +
              'Do not include markdown, code fences, raw secrets, or invented work.',
          },
          {
            role: 'user',
            content: buildReportPrompt(input),
          },
        ],
        max_tokens: 1200,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RedPill report returned ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('RedPill report missing content');
    return parseDraft(content);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`RedPill report timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function buildReportPrompt(input: {
  githubLogin: string;
  commits: CommitMeta[];
  days: string[];
}): string {
  const commits = input.commits
    .map((c) => `- ${toDateKey(new Date(c.timestamp))} ${c.repo}: ${c.message}`)
    .join('\n');
  return (
    `Create a weekly report for @${input.githubLogin} covering these dates: ${input.days.join(', ')}.\n` +
    'Return JSON exactly like {"overview":"...","days":[{"date":"YYYY-MM-DD","summary":"...","highlights":["..."]}]}.\n' +
    'The days array must contain one entry for every listed date in the same order. Keep overview under 500 chars, summaries under 220 chars, and highlights short.\n' +
    `Commits:\n${commits || '(none)'}`
  );
}

function parseDraft(content: string): ReportDraft {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(trimmed) as {
    overview?: unknown;
    days?: Array<{ date?: unknown; summary?: unknown; highlights?: unknown }>;
  };
  if (typeof parsed.overview !== 'string' || !Array.isArray(parsed.days)) {
    throw new Error('RedPill report returned an invalid shape');
  }
  return {
    overview: clean(parsed.overview, 500),
    days: parsed.days.map((day) => ({
      date: typeof day.date === 'string' ? day.date : '',
      summary: typeof day.summary === 'string' ? clean(day.summary, 220) : '',
      highlights: Array.isArray(day.highlights)
        ? day.highlights.filter((h): h is string => typeof h === 'string').slice(0, 5).map((h) => clean(h, 160))
        : [],
    })),
  };
}

function mergeDraft(base: WeeklyReport, draft: ReportDraft): WeeklyReport {
  const draftByDate = new Map(draft.days.map((day) => [day.date, day]));
  return {
    ...base,
    generatedBy: 'redpill-agent',
    overview: draft.overview || base.overview,
    days: base.days.map((day) => {
      const draftDay = draftByDate.get(day.date);
      if (!draftDay) return day;
      return {
        ...day,
        summary: draftDay.summary || day.summary,
        highlights: draftDay.highlights.length > 0 ? draftDay.highlights : day.highlights,
      };
    }),
  };
}

function groupByDay(commits: CommitMeta[]): Map<string, CommitMeta[]> {
  const grouped = new Map<string, CommitMeta[]>();
  for (const commit of commits) {
    const date = toDateKey(new Date(commit.timestamp));
    grouped.set(date, [...(grouped.get(date) ?? []), commit]);
  }
  return grouped;
}

function topRepos(commits: CommitMeta[]): string[] {
  const counts = new Map<string, number>();
  for (const commit of commits) counts.set(commit.repo, (counts.get(commit.repo) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([repo]) => repo);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - daysSinceMonday * DAY_MS);
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function weekday(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${dateKey}T00:00:00Z`));
}

function shortRepo(repo: string): string {
  return repo.includes('/') ? repo.split('/').at(-1)! : repo;
}

function clean(value: string, max: number): string {
  return value.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
