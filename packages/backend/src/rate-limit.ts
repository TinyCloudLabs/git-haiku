import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

/**
 * Layered brute-force limits for /api/haiku.
 *
 * The old limiter keyed every request by `ip|submittedCodeHash`, which let one
 * IP try unlimited different candidate codes. This module uses explicit
 * in-memory layers:
 *  - temp-ban/backoff precheck by IP before lookup/audit
 *  - per-IP invalid-attempt bucket independent of the submitted code
 *  - per-submitted-code invalid bucket using only a hash prefix
 *  - per-IP+owner bucket after a code matches
 */

export const HAIKU_RATE_MAX = Number(process.env['GITHAIKU_HAIKU_RATE_MAX'] ?? 20);
export const HAIKU_RATE_WINDOW_MS = parseWindowMs(process.env['GITHAIKU_HAIKU_RATE_WINDOW'] ?? '1 minute');
export const HAIKU_INVALID_IP_MAX = Number(process.env['GITHAIKU_INVALID_IP_MAX'] ?? HAIKU_RATE_MAX);
export const HAIKU_INVALID_CODE_MAX = Number(process.env['GITHAIKU_INVALID_CODE_MAX'] ?? HAIKU_RATE_MAX);
export const HAIKU_TEMP_BAN_MS = Number(process.env['GITHAIKU_TEMP_BAN_MS'] ?? 60_000);
export const HAIKU_BACKOFF_BASE_MS = Number(process.env['GITHAIKU_BACKOFF_BASE_MS'] ?? 1_000);

export type HaikuRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; reason: 'rate_limited' };

interface Bucket {
  count: number;
  resetAt: number;
}

interface IpPenalty extends Bucket {
  banUntil: number;
  violations: number;
}

const invalidIpBuckets = new Map<string, IpPenalty>();
const invalidCodeBuckets = new Map<string, Bucket>();
const matchedOwnerBuckets = new Map<string, Bucket>();

function parseWindowMs(value: string): number {
  const trimmed = value.trim().toLowerCase();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;

  const match = /^(\d+)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hour|hours)$/.exec(
    trimmed,
  );
  if (!match) return 60_000;

  const amount = Number(match[1] ?? '0');
  const unit = match[2] ?? '';
  if (unit === 'ms' || unit.startsWith('millisecond')) return amount;
  if (unit === 's' || unit.startsWith('sec')) return amount * 1_000;
  if (unit === 'm' || unit.startsWith('min')) return amount * 60_000;
  return amount * 60 * 60_000;
}

function nowMs(): number {
  return Date.now();
}

function codeKey(code: string): string {
  if (!code) return 'nocode';
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

function getBucket(map: Map<string, Bucket>, key: string, now: number): Bucket {
  const existing = map.get(key);
  if (existing && existing.resetAt > now) return existing;
  const created = { count: 0, resetAt: now + HAIKU_RATE_WINDOW_MS };
  map.set(key, created);
  return created;
}

function getIpPenalty(ip: string, now: number): IpPenalty {
  const existing = invalidIpBuckets.get(ip);
  if (existing && existing.resetAt > now) return existing;
  const created = { count: 0, resetAt: now + HAIKU_RATE_WINDOW_MS, banUntil: existing?.banUntil ?? 0, violations: 0 };
  invalidIpBuckets.set(ip, created);
  return created;
}

function denied(retryAfterMs: number): HaikuRateLimitResult {
  return { allowed: false, retryAfterMs: Math.max(1_000, retryAfterMs), reason: 'rate_limited' };
}

function allow(): HaikuRateLimitResult {
  return { allowed: true };
}

export function checkHaikuRequestBackoff(request: FastifyRequest): HaikuRateLimitResult {
  const now = nowMs();
  const penalty = invalidIpBuckets.get(request.ip);
  if (penalty && penalty.banUntil > now) {
    return denied(penalty.banUntil - now);
  }
  return allow();
}

export function consumeInvalidHaikuAttempt(request: FastifyRequest, code: string): HaikuRateLimitResult {
  const now = nowMs();
  const ipBucket = getIpPenalty(request.ip, now);
  if (ipBucket.banUntil > now) {
    return denied(ipBucket.banUntil - now);
  }

  ipBucket.count += 1;
  const submittedCodeBucket = getBucket(invalidCodeBuckets, codeKey(code), now);
  submittedCodeBucket.count += 1;

  const overIp = ipBucket.count > HAIKU_INVALID_IP_MAX;
  const overCode = submittedCodeBucket.count > HAIKU_INVALID_CODE_MAX;
  if (!overIp && !overCode) return allow();

  ipBucket.violations += 1;
  const exponential = HAIKU_BACKOFF_BASE_MS * 2 ** Math.min(ipBucket.violations - 1, 6);
  ipBucket.banUntil = now + Math.max(HAIKU_TEMP_BAN_MS, exponential);
  return denied(ipBucket.banUntil - now);
}

export function consumeMatchedOwnerHaikuAttempt(request: FastifyRequest, ownerId: string): HaikuRateLimitResult {
  const now = nowMs();
  const bucket = getBucket(matchedOwnerBuckets, `${request.ip}|${ownerId}`, now);
  bucket.count += 1;
  if (bucket.count <= HAIKU_RATE_MAX) return allow();
  return denied(bucket.resetAt - now);
}

/** Reset in-memory limiter state (tests only). */
export function resetHaikuRateLimits(): void {
  invalidIpBuckets.clear();
  invalidCodeBuckets.clear();
  matchedOwnerBuckets.clear();
}
