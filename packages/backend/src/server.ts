import cors from '@fastify/cors';
import {
  type EgressPayload,
  guardOutboundPayload,
  serializeGuardedResponse,
} from '@githaiku/shared';
import Fastify, { type FastifyInstance } from 'fastify';

import { config } from './config';
import { fetchRecentCommits } from './github';
import { makeHaikuGenerator } from './haiku';
import { devProof } from './proof';
import { makeSecretsProvider } from './secrets';
import { createOwner, findOwnerByCode } from './store';

/**
 * The haiku endpoint is the egress choke point. EVERY response on /api/haiku is
 * built into an EgressPayload and sent through the output guard
 * (sanitize -> validate -> serialize). Denials and errors carry no commit data.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const secrets = makeSecretsProvider();

  app.register(cors, { origin: true });

  // --- Health (operational, not part of the haiku egress contract) --------
  app.get('/health', async () => ({
    ok: true,
    service: 'githaiku-backend',
    mode: 'dev',
    secretsProvider: secrets.kind,
    haikuGenerator: config.useAnthropic ? 'anthropic' : 'deterministic',
  }));

  // --- Attestation stub (DEFERRED: real dstack quote/event_log/compose_hash)
  app.get('/attestation', async () => ({
    deferred: true,
    note: 'dstack TEE attestation is deferred for the preview. proof.image_digest / proof.attestation_url are null.',
    quote: null,
    event_log: null,
    compose_hash: null,
    app_id: null,
  }));

  // --- Owner setup (dev-local store) --------------------------------------
  // DEV-ONLY: in prod the owner signs in with OpenKey and stores secrets in
  // TinyCloud Secrets via the web-sdk. That is deferred; here we persist to the
  // gitignored dev store and mint a secret code.
  app.post('/api/owner', async (request, reply) => {
    const body = (request.body ?? {}) as {
      githubLogin?: unknown;
      githubToken?: unknown;
      anthropicKey?: unknown;
    };

    const githubLogin = typeof body.githubLogin === 'string' ? body.githubLogin.trim() : '';
    if (!githubLogin) {
      reply.code(400);
      return { error: 'githubLogin is required' };
    }

    const result = createOwner({
      githubLogin,
      githubToken: typeof body.githubToken === 'string' && body.githubToken ? body.githubToken : null,
      anthropicKey: typeof body.anthropicKey === 'string' && body.anthropicKey ? body.anthropicKey : null,
    });

    reply.code(201);
    return result;
  });

  // --- Requester: code -> haiku (THE egress choke point) -------------------
  app.post('/api/haiku', async (request, reply) => {
    reply.header('content-type', 'application/json');

    const body = (request.body ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';

    // 1. Validate the secret code (constant-time lookup).
    const owner = code ? findOwnerByCode(code) : null;
    if (!owner) {
      // Clean denial. No commit data. Guarded shape.
      const denial: EgressPayload = { allowed: false, reason: 'invalid code' };
      return reply.send(serializeGuardedResponse(denial));
    }

    try {
      // 2. Resolve the owner's secrets (dev-local; tc-cli deferred).
      const ownerSecrets = await secrets.getOwnerSecrets(owner);

      // 3. Fetch bounded commit metadata (messages/repos/timestamps only).
      const { commits } = await fetchRecentCommits({
        githubLogin: owner.githubLogin,
        githubToken: ownerSecrets.githubToken,
      });

      if (commits.length === 0) {
        const denial: EgressPayload = { allowed: false, reason: 'no recent activity' };
        return reply.send(serializeGuardedResponse(denial));
      }

      // 4. Generate the haiku (deterministic by default; anthropic deferred).
      const generator = makeHaikuGenerator(ownerSecrets.anthropicKey);
      const lines = await generator.generate(commits);

      // 5. Build the guarded success shape. guardOutboundPayload sanitizes the
      //    snapshot (only haiku.lines + proof survive) then validates it.
      const success: EgressPayload = {
        allowed: true,
        haiku: { lines },
        proof: devProof(),
      };
      const guarded = guardOutboundPayload(success);
      return reply.send(JSON.stringify(guarded));
    } catch (err) {
      // Operational failure. Redacted to a denial carrying no commit data.
      reply.code(200);
      return reply.send(serializeGuardedResponse(err));
    }
  });

  return app;
}
