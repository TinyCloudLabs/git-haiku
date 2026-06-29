import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { EgressPayload } from '@githaiku/shared';

import { config } from './config';
import type { WeeklyReport } from './report';

type CacheKind = 'haiku:recent' | 'report:last-week';

interface CacheEntry<T> {
  kind: CacheKind;
  ownerId: string;
  scope: string;
  commitFingerprint: string;
  cachedAt: string;
  value: T;
}

interface CacheFile {
  entries: Record<string, CacheEntry<unknown>>;
}

const CACHE_PATH = join(config.dataDir, 'generation-cache.json');

function load(): CacheFile {
  if (!existsSync(CACHE_PATH)) {
    return { entries: {} };
  }
  return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as CacheFile;
}

function persist(data: CacheFile): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function cacheKey(kind: CacheKind, ownerId: string, scope: string): string {
  return `${kind}:${ownerId}:${scope}`;
}

function readCached<T>(kind: CacheKind, ownerId: string, scope: string, commitFingerprint: string): T | null {
  const entry = load().entries[cacheKey(kind, ownerId, scope)];
  if (!entry || entry.commitFingerprint !== commitFingerprint) {
    return null;
  }
  return entry.value as T;
}

function writeCached<T>(
  kind: CacheKind,
  ownerId: string,
  scope: string,
  commitFingerprint: string,
  value: T,
): void {
  const data = load();
  data.entries[cacheKey(kind, ownerId, scope)] = {
    kind,
    ownerId,
    scope,
    commitFingerprint,
    cachedAt: new Date().toISOString(),
    value,
  };
  persist(data);
}

export function readCachedHaiku(ownerId: string, commitFingerprint: string): EgressPayload | null {
  return readCached<EgressPayload>('haiku:recent', ownerId, 'default', commitFingerprint);
}

export function writeCachedHaiku(
  ownerId: string,
  commitFingerprint: string,
  payload: EgressPayload,
): void {
  writeCached('haiku:recent', ownerId, 'default', commitFingerprint, payload);
}

export function readCachedWeeklyReport(
  ownerId: string,
  scope: string,
  commitFingerprint: string,
): WeeklyReport | null {
  return readCached<WeeklyReport>('report:last-week', ownerId, scope, commitFingerprint);
}

export function writeCachedWeeklyReport(
  ownerId: string,
  scope: string,
  commitFingerprint: string,
  report: WeeklyReport,
): void {
  writeCached('report:last-week', ownerId, scope, commitFingerprint, report);
}
