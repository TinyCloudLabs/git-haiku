import type { FastifyRequest } from 'fastify';

/**
 * Rate limiting for /api/haiku (brute-force protection for secret codes).
 *
 * Keyed by BOTH the submitted code and the client IP: a single key cannot be
 * brute-forced from one IP, and a single code cannot be hammered from many IPs.
 * The key is `<ip>|<codeHashPrefix>` — we never put the raw code in the key.
 *
 * Tunable via env: GITHAIKU_HAIKU_RATE_MAX (default 20) requests per
 * GITHAIKU_HAIKU_RATE_WINDOW (default '1 minute').
 */

import { createHash } from 'node:crypto';

export const HAIKU_RATE_MAX = Number(process.env['GITHAIKU_HAIKU_RATE_MAX'] ?? 20);
export const HAIKU_RATE_WINDOW = process.env['GITHAIKU_HAIKU_RATE_WINDOW'] ?? '1 minute';

/** Build the rate-limit key from IP + a hash prefix of the submitted code. */
export function haikuRateKey(request: FastifyRequest): string {
  const body = (request.body ?? {}) as { code?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const codePart = code
    ? createHash('sha256').update(code).digest('hex').slice(0, 12)
    : 'nocode';
  return `${request.ip}|${codePart}`;
}
