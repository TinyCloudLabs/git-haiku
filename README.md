# Git Haiku

An owner stores a GitHub token and hands out a secret code. A
requester enters the code, clicks a button, and gets back **only** a haiku about
the owner's recent git activity. The haiku is the toy; the real point is the
trust contract: credentials never leak, the only data-bearing output is a 3-line
haiku, and denials/errors carry no commit data.

This repo is a **runnable local preview** of the core flow with explicit,
labeled dev-mode fallbacks. The infra-heavy trust pieces are deferred behind
flags (see [Dev mode vs. deferred](#dev-mode-vs-deferred)).

## Run the preview (one command)

```bash
pnpm install
pnpm dev
```

- Frontend (the app): **http://localhost:5173**
- Backend (HTTP API): **http://127.0.0.1:8787** (health: `GET /health`)

`pnpm dev` runs the backend (Fastify) and frontend (Vite + React) concurrently.

### Drive the flow

1. Open **http://localhost:5173**.
2. **Owner setup** tab → enter a GitHub login (e.g. `octocat`), leave the token
   blank, **Generate secret code**. Copy the code.
   - (Or seed one from the CLI: `pnpm seed` prints a secret code.)
3. **Get a haiku** tab → paste the code → **Get Haiku** → a 3-line haiku renders.
4. Enter a wrong code → a clean denial (`invalid code`) with no commit data.

### What the preview demonstrates

- **Requester flow (the hero):** secret code → `POST /api/haiku` → 3-line haiku
  in the guarded egress shape, or a clean denial.
- **Owner setup:** store a GitHub login (+ optional token), mint a shareable
  secret code.
- **Output guard (the trust core):** every haiku response is built into a plain
  snapshot, **sanitized → Ajv-validated → serialized**. The only data-bearing
  success field is `haiku.lines`; denials/errors carry only a short `reason`.
- **Commit-messages-only GitHub adapter:** messages, repo names, timestamps —
  never file contents or diffs — hard-capped by count + time window.
- **Haiku generator:** RedPill (Phala's confidential LLM gateway) when a
  backend-global `REDPILL_API_KEY` is set; otherwise a deterministic template
  (same commits → same haiku, no key needed) so the zero-secret preview works.

Example success response:

```json
{
  "allowed": true,
  "haiku": { "lines": ["old branches whisper", "the log remembers each step", "a clean tree at last"] },
  "proof": { "policy_id": "secret-code-v1", "image_digest": null, "attestation_url": null }
}
```

Example denial (wrong code):

```json
{ "allowed": false, "reason": "invalid code" }
```

## Dev mode vs. deferred

| Concern | Preview (dev mode) | Real trust contract (in-TEE) |
|---|---|---|
| Owner secrets | Gitignored local store (`.githaiku-dev/`) | TinyCloud Secrets via web-sdk |
| Secret reads | `SecretsProvider=local` | `tc-cli` (`@tinycloud/cli@0.7.0-beta.1`, real `tc secrets get --delegation`) — `GITHAIKU_SECRETS_PROVIDER=tc-cli` (**wired**; needs a node + backend key + stored delegation, else fails loudly) |
| Backend key | `GITHAIKU_BACKEND_PRIVATE_KEY` env | **dstack-derived in-TEE** (`@phala/dstack-sdk` `getKey('githaiku/keys/backend')`); key never leaves the enclave |
| Delegation store | Gitignored JSON (`local`) | Backend's own **TinyCloud KV** space (`tc-cli`) |
| Audit log | Gitignored JSONL file (`local`) | Backend's own **TinyCloud KV** space (`tc-cli`), append-only |
| Haiku generation | RedPill if `REDPILL_API_KEY` set, else deterministic template | RedPill (`phala/deepseek-v4-flash`, TEE-attestable) — backend-global key, **not** an owner secret |
| GitHub token | Optional; falls back to a labeled dev fixture | Required, from owner's stored token |
| `proof` block | Dev placeholder (`image_digest`/`attestation_url` = `null`) | **Real dstack provenance** — `image_digest` = compose_hash, `attestation_url` = this app's `/attestation` |
| `/attestation` | Clearly-marked dev stub (`dev: true`) | **Real dstack TDX quote** + event log + compose_hash + app_id |
| Owner auth | **SIWE-style signature** (same in both modes) | **SIWE-style signature** (owner signs a server nonce; OpenKey provides the key) |
| Requester surface | Web button | + MCP tool (deferred) |

The dev fallbacks are **explicit, labeled product behavior**, not error masking.
Selecting a deferred provider (e.g. `tc-cli`) throws loudly rather than silently
degrading. TEE behavior is gated on `GITHAIKU_TEE=1` or a reachable
`/var/run/dstack.sock`.

## Owner authentication (SIWE-style)

Owner-scoped endpoints are authenticated by an Ethereum signature over a
one-time server nonce (the owner controls the key behind their `did:pkh`; in
production OpenKey holds that key). Flow:

1. `GET /api/auth/nonce` → `{ nonce }` (one-time, 5-min TTL).
2. Owner signs the canonical message: `Git Haiku owner authentication\n\nNonce: <nonce>`.
3. Send these **headers** on the authenticated request:
   - `x-githaiku-address`: the owner's address
   - `x-githaiku-nonce`: the nonce
   - `x-githaiku-signature`: the signature

The backend recovers the signer, confirms it matches the address, and **burns
the nonce** (nonce-based replay protection). Authenticated: `POST /api/owner`,
`POST /api/delegations`, `GET|POST /api/codes`, `POST /api/codes/{rotate,revoke}`,
`GET /api/audit`. Public: `GET /health`, `GET /attestation`,
`GET /api/server-info`, `GET /api/auth/nonce`, `POST /api/haiku` (code-gated,
rate-limited).

## Layout

- `packages/shared` — egress schema (single source of truth) + output guard.
- `packages/backend` — Fastify API. Public: `POST /api/haiku`, `GET /health`,
  `GET /attestation` (real dstack quote in-TEE, dev stub otherwise),
  `GET /api/auth/nonce`, `GET /api/server-info` (tc-cli only). Owner-authed:
  `POST /api/owner`, `POST /api/delegations` (tc-cli only), `GET|POST /api/codes`,
  `POST /api/codes/rotate`, `POST /api/codes/revoke`, `GET /api/audit`. Modules:
  `auth.ts` (SIWE-style nonce auth), `identity.ts` (stable did:pkh;
  dstack-derived key in-TEE via `tee.ts`), `attestation.ts` + `proof.ts`
  (dstack TDX quote + provenance binding), `secrets.ts` (`local` + real
  `tc-cli`), `delegation-store.ts` + `audit.ts` (TinyCloud KV in tc-cli, file in
  local), `store.ts` (owners + multi-code create/revoke/rotate, hashes only),
  `rate-limit.ts`, commit-messages-only GitHub adapter, RedPill + deterministic
  haiku core.
- `packages/frontend` — Vite + React: requester page (hero) + owner setup page;
  proxies `/api` to the backend.

## Useful flags / env

| Env | Default | Effect |
|---|---|---|
| `PORT` | `8787` | Backend port |
| `GITHAIKU_SECRETS_PROVIDER` | `local` | `local` or `tc-cli` (real delegated reads + KV delegation/audit store) |
| `GITHAIKU_TEE` | _(none)_ | `1` (or a reachable `/var/run/dstack.sock`) enables in-TEE behavior: dstack-derived backend key + real attestation |
| `GITHAIKU_BACKEND_PRIVATE_KEY` | _(none)_ | tc-cli **dev** only: backend stable identity. Ignored in-TEE (key is dstack-derived). Its did:pkh is the delegation audience |
| `GITHAIKU_NODE_HOST` | `https://node.tinycloud.xyz` | TinyCloud node for the backend identity + delegated reads |
| `GITHAIKU_PUBLIC_URL` | _(none)_ | Public base URL; binds the haiku proof's `attestation_url` in-TEE |
| `GITHAIKU_HAIKU_RATE_MAX` | `20` | Max `/api/haiku` requests per window, per IP+code key |
| `GITHAIKU_HAIKU_RATE_WINDOW` | `1 minute` | Rate-limit window for `/api/haiku` |
| `GITHAIKU_HAIKU_GENERATOR` | _(auto)_ | Force `redpill` or `deterministic`. Default: `redpill` if `REDPILL_API_KEY` is set, else `deterministic` |
| `REDPILL_API_KEY` | _(none)_ | Backend-global RedPill key. When set, RedPill is the default generator. **Not** an owner secret |
| `REDPILL_MODEL` | `phala/deepseek-v4-flash` | RedPill model (the `phala/` namespace = TEE-attestable inference) |
| `REDPILL_BASE_URL` | `https://api.redpill.ai/v1` | RedPill API base URL |
| `REDPILL_TIMEOUT_MS` | `20000` | RedPill request timeout |
| `GITHAIKU_MAX_COMMITS` | `30` | GitHub commit cap |
| `GITHAIKU_WINDOW_DAYS` | `30` | GitHub time window |

### Local dev env (`.githaiku-dev/dev.env`)

For the portless preview, the backend auto-loads `KEY=value` lines from
`.githaiku-dev/dev.env` into `process.env` at startup **if the file exists** —
so RedPill picks up `REDPILL_API_KEY` / `REDPILL_MODEL` without exporting them by
hand. `.githaiku-dev/` is gitignored; never commit the key. The loader:

- never overrides an already-set env var (an explicit export always wins),
- is a no-op when `NODE_ENV=production` or `GITHAIKU_TEE=1` (never loads dev
  secrets in production / the TEE),
- never logs the values it loads.

With no `dev.env` and no exported key, the preview falls back to the
deterministic generator, so `pnpm dev` works with zero secrets.

## Test & build

```bash
pnpm test    # shared (guard, incl. sanitize-before-validate) + backend (egress flow)
pnpm build   # typecheck backend + build frontend
```

### Live delegated-secrets integration (real node, gated)

Proves the real tc-cli path end-to-end against a **local** tinycloud-node: a
throwaway owner puts GITHUB_TOKEN (the owner's only delegated secret), delegates
KV-get + decrypt to the backend's stable `did:pkh`, delivers the delegation
(`POST /api/delegations`), and the backend reads GITHUB_TOKEN via the real `tc`
CLI. The RedPill LLM key is backend config, not an owner secret. Not part of
`pnpm test`.

```bash
GITHAIKU_LIVE=1 pnpm --filter @githaiku/backend test:live
# optional: GITHAIKU_LIVE_GITHUB_TOKEN=<real ro token> GITHAIKU_LIVE_GITHUB_LOGIN=<login>
#           GITHAIKU_NODE_BIN=<path to tinycloud binary> GITHAIKU_LIVE_PORT=<port>
```

## Deploy to Phala (dstack TEE)

The backend ships as a single amd64 image and runs in a dstack CVM where it
derives its key and produces real attestation. Artifacts:

- `Dockerfile` — multi-stage amd64 backend image (runs the built backend via tsx).
- `docker-compose.phala.yml` — backend + `dstack-ingress`; mounts
  `/var/run/dstack.sock`; all secrets are dstack **encrypted env** (`${...}`
  refs), never baked in.
- `phala.toml` — CVM config (`gateway_port = 8787`, `public_logs = false`).
- `.env.example` — the env contract (copy to `.env.prod`, fill, never commit).

```bash
# build + push the image (amd64 REQUIRED — Phala runs Intel TDX)
pnpm docker:build      # docker buildx build --platform linux/amd64 ...
pnpm docker:push

# deploy (encrypts .env.prod client-side; needs phala creds)
pnpm deploy:phala      # phala deploy -c docker-compose.phala.yml -e .env.prod --wait
```

In-TEE the backend sets `GITHAIKU_TEE=1` + `GITHAIKU_SECRETS_PROVIDER=tc-cli`:
the backend key is derived via the dstack socket (never leaves the enclave),
delegations + the audit log live in the backend's TinyCloud KV space, and
`/api/haiku` proofs carry the real compose_hash + `/attestation` URL.
