import cors from '@fastify/cors';
import {
  type EgressPayload,
  guardOutboundPayload,
  serializeGuardedResponse,
} from '@githaiku/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { getAttestation, verifyTeeStartup } from './attestation';
import { AuthError, nonceStore, verifyOwnerAuth, type OwnerAuth } from './auth';
import { readAudit, recordAudit, recordInvalidCodeAudit } from './audit';
import { config } from './config';
import { storeDelegation } from './delegation-store';
import { validateDelegation } from './delegations';
import { fetchRecentCommits } from './github';
import { makeHaikuGenerator } from './haiku';
import { getBackendIdentity } from './identity';
import { backendPolicy, ownerDidFromAddress } from './policy';
import { buildProof } from './proof';
import {
  checkHaikuRequestBackoff,
  consumeInvalidHaikuAttempt,
  consumeMatchedOwnerHaikuAttempt,
  type HaikuRateLimitResult,
} from './rate-limit';
import { makeSecretsProvider } from './secrets';
import {
  createCode,
  createOwner,
  findOwnerByAddress,
  findOwnerById,
  findOwnerByCode,
  listCodes,
  revokeCode,
  rotateCodes,
  type OwnerRecord,
} from './store';

/**
 * The haiku endpoint is the egress choke point. EVERY response on /api/haiku is
 * built into an EgressPayload and sent through the output guard
 * (sanitize -> validate -> serialize). Denials and errors carry no commit data.
 *
 * Owner-scoped endpoints (/api/owner, /api/delegations, /api/codes/*,
 * /api/audit) are OWNER-AUTHENTICATED via a SIWE-style signature (see auth.ts).
 * Public: /health, /attestation, /api/server-info, /api/auth/nonce, /api/haiku.
 */
export async function buildServer(): Promise<FastifyInstance> {
  await verifyTeeStartup();

  const app = Fastify({ logger: false });
  const secrets = makeSecretsProvider();

  app.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith('/api/haiku')) {
      reply.code(503);
      reply.header('content-type', 'application/json');
      return reply.send(serializeGuardedResponse(error));
    }

    const statusCode = redactedStatusCode(error);
    reply.code(statusCode);
    return { error: statusCode === 400 ? 'bad_request' : 'unavailable' };
  });

  await app.register(cors, { origin: corsOrigin() });

  // --- Health (operational, not part of the haiku egress contract) --------
  app.get('/health', async () => ({ ok: true }));

  // --- Attestation: real dstack TDX quote in-TEE, dev stub otherwise -------
  app.get('/attestation', async (_request, reply) => {
    try {
      return await getAttestation();
    } catch {
      reply.code(503);
      return { error: 'attestation_unavailable', message: 'attestation is unavailable' };
    }
  });

  // --- Auth nonce (public): owner GETs a one-time nonce to sign ------------
  app.get('/api/auth/nonce', async () => ({ nonce: nonceStore.issue() }));

  // --- Server info (no auth): backend DID + the policy owners must delegate -
  app.get('/api/server-info', async (_request, reply) => {
    if (secrets.kind !== 'tc-cli') {
      reply.code(404);
      return { error: 'not_found' };
    }
    try {
      const identity = await getBackendIdentity();
      return {
        did: identity.did,
        name: 'Git Haiku Backend',
        permissions: backendPolicy(),
      };
    } catch {
      reply.code(503);
      return { error: 'unavailable' };
    }
  });

  // --- Owner setup (OWNER-AUTHENTICATED) ----------------------------------
  // The owner signs the auth message; we bind the created owner to their
  // recovered address. In prod the owner stores secrets in TinyCloud Secrets via
  // the web-sdk; the dev store persists githubToken to the gitignored file.
  app.post('/api/owner', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const body = (request.body ?? {}) as { githubLogin?: unknown; githubToken?: unknown };
    const githubLogin = typeof body.githubLogin === 'string' ? body.githubLogin.trim() : '';
    if (!githubLogin) {
      reply.code(400);
      return { error: 'githubLogin is required' };
    }

    // One address = one owner. A returning owner manages their existing record
    // via the code/secret endpoints rather than creating a duplicate.
    if (findOwnerByAddress(auth.address)) {
      reply.code(409);
      return { error: 'owner_exists', message: 'an owner already exists for this address' };
    }

    const result = createOwner({
      githubLogin,
      githubToken: typeof body.githubToken === 'string' && body.githubToken ? body.githubToken : null,
      ownerAddress: auth.address,
    });
    reply.code(201);
    return result;
  });

  // --- Receive an owner's delegation (OWNER-AUTHENTICATED) -----------------
  app.post('/api/delegations', async (request, reply) => {
    if (secrets.kind !== 'tc-cli') {
      reply.code(404);
      return { error: 'delegations are only accepted under the tc-cli secrets provider' };
    }
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const body = (request.body ?? {}) as { ownerId?: unknown; serialized?: unknown };
    const ownerId = typeof body.ownerId === 'string' ? body.ownerId : '';
    const serialized = typeof body.serialized === 'string' ? body.serialized : '';

    if (!ownerId || !serialized) {
      reply.code(400);
      return { error: 'ownerId and serialized are required' };
    }
    const owner = findOwnerById(ownerId);
    if (!owner) {
      reply.code(404);
      return { error: 'unknown ownerId' };
    }
    // The authenticated owner must own this record.
    if (!owner.ownerAddress || owner.ownerAddress !== auth.address.toLowerCase()) {
      reply.code(403);
      return { error: 'forbidden', message: 'authenticated address does not own this record' };
    }

    try {
      const identity = await getBackendIdentity();
      const validated = validateDelegation(serialized, identity.did);
      await storeDelegation({
        ownerId,
        serialized,
        ownerDid: ownerDidFromAddress(auth.address),
        grantedAt: new Date().toISOString(),
        expiresAt: validated.expiresAt,
      });
      reply.code(201);
      return { status: 'active', expiresAt: validated.expiresAt };
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_delegation', message: err instanceof Error ? err.message : String(err) };
    }
  });

  // --- Code management (OWNER-AUTHENTICATED) -------------------------------
  app.get('/api/codes', async (request, reply) => {
    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;
    return { codes: listCodes(ctx.owner.ownerId) };
  });

  app.post('/api/codes', async (request, reply) => {
    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;
    reply.code(201);
    return createCode(ctx.owner.ownerId);
  });

  app.post('/api/codes/rotate', async (request, reply) => {
    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;
    return rotateCodes(ctx.owner.ownerId);
  });

  app.post('/api/codes/revoke', async (request, reply) => {
    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;
    const body = (request.body ?? {}) as { codeId?: unknown };
    const codeId = typeof body.codeId === 'string' ? body.codeId : '';
    if (!codeId) {
      reply.code(400);
      return { error: 'codeId is required' };
    }
    try {
      return revokeCode(ctx.owner.ownerId, codeId);
    } catch {
      reply.code(404);
      return { error: 'unknown codeId' };
    }
  });

  // --- Audit trail (OWNER-AUTHENTICATED) ----------------------------------
  app.get('/api/audit', async (request, reply) => {
    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;
    return { entries: await readAudit(ctx.owner.ownerId) };
  });

  // --- Requester: code -> haiku (THE egress choke point) -------------------
  app.post(
    '/api/haiku',
    async (request, reply) => {
      reply.header('content-type', 'application/json');

      const body = (request.body ?? {}) as { code?: unknown };
      const code = typeof body.code === 'string' ? body.code.trim() : '';

      const backoff = checkHaikuRequestBackoff(request);
      if (!backoff.allowed) {
        return sendRateLimited(reply, backoff);
      }

      // 1. Validate the secret code (constant-time lookup).
      const owner = code ? findOwnerByCode(code) : null;
      if (!owner) {
        const invalidLimit = consumeInvalidHaikuAttempt(request, code);
        if (!invalidLimit.allowed) {
          return sendRateLimited(reply, invalidLimit);
        }
        try {
          await recordInvalidCodeAudit({ ip: request.ip });
        } catch (err) {
          reply.code(503);
          return reply.send(serializeGuardedResponse(err));
        }
        const denial: EgressPayload = { allowed: false, reason: 'invalid code' };
        return reply.send(serializeGuardedResponse(denial));
      }

      const matchedLimit = consumeMatchedOwnerHaikuAttempt(request, owner.ownerId);
      if (!matchedLimit.allowed) {
        return sendRateLimited(reply, matchedLimit);
      }

      try {
        // 2. Resolve the owner's secrets (dev-local or tc-cli delegated).
        const ownerSecrets = await secrets.getOwnerSecrets(owner);

        // 3. Fetch bounded commit metadata (messages/repos/timestamps only).
        const { commits } = await fetchRecentCommits({
          githubLogin: owner.githubLogin,
          githubToken: ownerSecrets.githubToken,
        });

        if (commits.length === 0) {
          await recordAudit({ code, ownerId: owner.ownerId, decision: 'deny', reason: 'no_recent_activity' });
          const denial: EgressPayload = { allowed: false, reason: 'no recent activity' };
          return reply.send(serializeGuardedResponse(denial));
        }

        // 4. Generate the haiku (RedPill when keyed; deterministic fallback).
        const generator = makeHaikuGenerator();
        const lines = await generator.generate(commits);

        // 5. Build the guarded success shape with real (in-TEE) provenance.
        const success: EgressPayload = {
          allowed: true,
          haiku: { lines },
          proof: await buildProof(),
        };
        const guarded = guardOutboundPayload(success);
        await recordAudit({ code, ownerId: owner.ownerId, decision: 'allow', reason: 'ok' });
        return reply.send(JSON.stringify(guarded));
      } catch (err) {
        // Operational failure. Redacted to a denial carrying no commit data.
        await recordAudit({ code, ownerId: owner.ownerId, decision: 'deny', reason: 'error' });
        reply.code(503);
        return reply.send(serializeGuardedResponse(err));
      }
    },
  );

  return app;
}

// ── auth helpers ─────────────────────────────────────────────────────

function corsOrigin(): true | string[] {
  if (config.allowedOrigins.length > 0) return [...config.allowedOrigins];
  if (process.env['NODE_ENV'] !== 'production' && process.env['GITHAIKU_TEE'] !== '1') return true;
  throw new Error('GITHAIKU_ALLOWED_ORIGINS is required in production/TEE mode');
}

function sendRateLimited(reply: FastifyReply, result: Exclude<HaikuRateLimitResult, { allowed: true }>): FastifyReply {
  const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1_000));
  reply.code(429);
  reply.header('retry-after', String(retryAfterSeconds));
  const denial: EgressPayload = { allowed: false, reason: 'rate limited' };
  return reply.send(serializeGuardedResponse(denial));
}

function redactedStatusCode(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) return statusCode;
  }
  return 503;
}

/**
 * Verify the owner-auth payload on a request; replies 401 + returns null on
 * failure. Auth is carried in headers (works uniformly for GET + POST):
 *   x-githaiku-address, x-githaiku-nonce, x-githaiku-signature.
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<OwnerAuth | null> {
  const h = request.headers;
  try {
    return await verifyOwnerAuth({
      address: h['x-githaiku-address'],
      nonce: h['x-githaiku-nonce'],
      signature: h['x-githaiku-signature'],
    });
  } catch (err) {
    reply.code(401);
    reply.send({ error: 'unauthenticated', message: err instanceof AuthError ? err.message : 'authentication failed' });
    return null;
  }
}

/** Authenticate AND resolve the owner record bound to that address. */
async function authenticateOwner(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ auth: OwnerAuth; owner: OwnerRecord } | null> {
  const auth = await authenticate(request, reply);
  if (!auth) return null;
  const owner = findOwnerByAddress(auth.address);
  if (!owner) {
    reply.code(404);
    reply.send({ error: 'no_owner', message: 'no owner record for the authenticated address' });
    return null;
  }
  return { auth, owner };
}
