import cors from '@fastify/cors';
import { type EgressPayload, serializeGuardedResponse } from '@githaiku/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { getAttestation, verifyTeeStartup } from './attestation';
import {
  AuthError,
  issueSessionToken,
  nonceStore,
  verifySessionToken,
  verifySIWE,
  type OwnerAuth,
} from './auth';
import { readAudit, recordAudit, recordInvalidCodeAudit } from './audit';
import { config } from './config';
import { storeDelegation } from './delegation-store';
import { validateDelegation } from './delegations';
import { getBackendIdentity, resolveBackendPrivateKey } from './identity';
import { generateHaikuForOwner } from './pipeline';
import { backendPolicy, ownerDidFromAddress } from './policy';
import {
  checkHaikuRequestBackoff,
  consumeInvalidHaikuAttempt,
  consumeMatchedOwnerHaikuAttempt,
  consumeOwnerPreviewAttempt,
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
 * /api/audit) are OWNER-AUTHENTICATED via a backend session JWT, established
 * from the single web-sdk SIWE sign-in signature (see auth.ts). Authed requests
 * carry `Authorization: Bearer <jwt>`.
 * Public: /health, /attestation, /api/server-info, /api/auth/nonce,
 * /api/auth/verify, /api/haiku.
 */
export async function buildServer(): Promise<FastifyInstance> {
  await verifyTeeStartup();

  // Logging ON. The backend runs in the attested TEE, so logging error MESSAGES
  // server-side is safe and is the only way to tell which pipeline stage failed.
  // We never log secret VALUES or raw commit contents (only generic + stage).
  const app = Fastify({ logger: { level: process.env['GITHAIKU_LOG_LEVEL'] ?? 'info' } });
  const secrets = makeSecretsProvider();

  app.setErrorHandler((error, request, reply) => {
    // Log the REAL error server-side (safe in the TEE) before redacting it out
    // of the response.
    request.log.error({ err: error, url: request.url }, 'request error');

    if (request.url.startsWith('/api/haiku') || request.url.startsWith('/api/preview')) {
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

  // --- Auth nonce (public): owner GETs a one-time, address-bound nonce -----
  // The web-sdk embeds this nonce in the SIWE message it asks the owner to sign.
  app.get('/api/auth/nonce', async (request, reply) => {
    const address = (request.query as { address?: unknown }).address;
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      reply.code(400);
      return { error: 'invalid_address', message: "query parameter 'address' must be an Ethereum address" };
    }
    return { nonce: nonceStore.issue(address) };
  });

  // --- Auth verify (public): SIWE sign-in signature -> backend session JWT --
  // The owner's single web-sdk SIWE signature is sent here. We verify it,
  // validate the embedded address-bound nonce (single-use replay protection),
  // and issue a JWT signed with the backend's stable key. No re-signing after.
  app.post('/api/auth/verify', async (request, reply) => {
    const body = (request.body ?? {}) as { message?: unknown; signature?: unknown };
    const message = typeof body.message === 'string' ? body.message : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    if (!message || !signature) {
      reply.code(400);
      return { error: 'invalid_request', message: 'message and signature are required' };
    }
    try {
      const { address, nonce } = await verifySIWE(message, signature);
      if (!nonceStore.validate(address, nonce)) {
        reply.code(401);
        return { error: 'invalid_nonce', message: 'nonce is invalid, expired, or already used' };
      }
      const privateKey = await resolveBackendPrivateKey();
      const { token, expiresIn } = await issueSessionToken(address, privateKey);
      return { token, expiresIn, address };
    } catch (err) {
      reply.code(401);
      return {
        error: 'verification_failed',
        message: err instanceof AuthError ? err.message : 'SIWE verification failed',
      };
    }
  });

  // --- Server info (no auth): backend DID + the policy owners must delegate -
  app.get('/api/server-info', async (_request, reply) => {
    if (secrets.kind !== 'sdk') {
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

  // --- Owner lookup (OWNER-AUTHENTICATED) ---------------------------------
  // A returning owner reads their existing record by authenticated address. No
  // code is minted on this read: secretCode/codeId are empty, which signals
  // "nothing newly minted" to the client.
  app.get('/api/owner', async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    const owner = findOwnerByAddress(auth.address);
    if (!owner) {
      reply.code(404);
      return { error: 'no_owner', message: 'no owner record for the authenticated address' };
    }
    return {
      ownerId: owner.ownerId,
      githubLogin: owner.githubLogin,
      hasGithubToken: owner.githubToken !== null,
      secretCode: '',
      codeId: '',
    };
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

    // One address = one owner. A returning owner gets their existing record back
    // (idempotent) — no duplicate record, no duplicate code. secretCode/codeId
    // are empty to signal "nothing newly minted".
    const existing = findOwnerByAddress(auth.address);
    if (existing) {
      reply.code(200);
      return {
        ownerId: existing.ownerId,
        githubLogin: existing.githubLogin,
        hasGithubToken: existing.githubToken !== null,
        secretCode: '',
        codeId: '',
      };
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
    if (secrets.kind !== 'sdk') {
      reply.code(404);
      return { error: 'delegations are only accepted under the sdk secrets provider' };
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

      // 2-5. Run the shared pipeline: secrets -> github -> generate -> guard.
      const result = await generateHaikuForOwner(owner, secrets);

      if (result.ok) {
        await recordAudit({ code, ownerId: owner.ownerId, decision: 'allow', reason: result.auditReason });
        return reply.send(JSON.stringify(result.payload));
      }

      // Staged, still-safe failure. Log the REAL error server-side (TEE-safe);
      // the response carries only a generic reason + the diagnostic stage.
      if (result.logError !== null) {
        request.log.error(
          { err: result.logError, stage: result.stage, ownerId: owner.ownerId },
          'haiku pipeline failed',
        );
      }
      await recordAudit({ code, ownerId: owner.ownerId, decision: 'deny', reason: result.auditReason });
      reply.code(result.statusCode);
      return reply.send(JSON.stringify(result.payload));
    },
  );

  // --- Owner preview: owner-authed full-pipeline run (THE diagnostic) -------
  // Same SIWE owner auth as the other owner endpoints. Resolves the owner by the
  // authenticated address and runs the EXACT same pipeline as /api/haiku so the
  // owner can test their setup and preview the haiku. Response is the guarded
  // egress shape: success (200) or the staged guarded denial (non-2xx).
  app.post('/api/preview', async (request, reply) => {
    reply.header('content-type', 'application/json');

    const ctx = await authenticateOwner(request, reply);
    if (!ctx) return;

    const previewLimit = consumeOwnerPreviewAttempt(ctx.owner.ownerId);
    if (!previewLimit.allowed) {
      return sendRateLimited(reply, previewLimit);
    }

    const result = await generateHaikuForOwner(ctx.owner, secrets);

    if (result.ok) {
      await recordAudit({ code: '', ownerId: ctx.owner.ownerId, decision: 'allow', reason: 'preview_ok' });
      return reply.send(JSON.stringify(result.payload));
    }

    if (result.logError !== null) {
      request.log.error(
        { err: result.logError, stage: result.stage, ownerId: ctx.owner.ownerId },
        'preview pipeline failed',
      );
    }
    await recordAudit({ code: '', ownerId: ctx.owner.ownerId, decision: 'deny', reason: `preview_${result.auditReason}` });
    reply.code(result.statusCode);
    return reply.send(JSON.stringify(result.payload));
  });

  return app;
}

// ── auth helpers ─────────────────────────────────────────────────────

// The project's Cloudflare Pages domain: canonical `git-haiku.pages.dev` plus
// per-deploy preview subdomains (`<hash>.git-haiku.pages.dev`). Always allowed
// in addition to the configured exact origins (e.g. githaiku.com).
const PAGES_DEV_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?git-haiku\.pages\.dev$/;

function corsOrigin(): true | (string | RegExp)[] {
  if (config.allowedOrigins.length > 0) return [...config.allowedOrigins, PAGES_DEV_ORIGIN];
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
 * Verify the backend session JWT on a request; replies 401 + returns null on
 * failure. Auth is carried in the `Authorization: Bearer <jwt>` header (works
 * uniformly for GET + POST). The JWT was issued at /api/auth/verify from the
 * owner's single SIWE sign-in signature — no per-request signing.
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<OwnerAuth | null> {
  const header = request.headers.authorization;
  const token =
    typeof header === 'string' ? (header.startsWith('Bearer ') ? header.slice(7) : header) : '';
  if (!token) {
    reply.code(401);
    reply.send({ error: 'unauthenticated', message: 'Authorization bearer token is required' });
    return null;
  }
  try {
    const privateKey = await resolveBackendPrivateKey();
    return await verifySessionToken(token, privateKey);
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
