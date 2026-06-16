# Git Haiku

An owner stores a GitHub token + Anthropic key and hands out a secret code. A
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
- **Owner setup:** store a GitHub login (+ optional token / Anthropic key),
  mint a shareable secret code.
- **Output guard (the trust core):** every haiku response is built into a plain
  snapshot, **sanitized → Ajv-validated → serialized**. The only data-bearing
  success field is `haiku.lines`; denials/errors carry only a short `reason`.
- **Commit-messages-only GitHub adapter:** messages, repo names, timestamps —
  never file contents or diffs — hard-capped by count + time window.
- **Deterministic haiku generator:** same commits → same haiku, no Anthropic key
  needed.

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

| Concern | Preview (dev mode) | Real trust contract (deferred) |
|---|---|---|
| Owner secrets | Gitignored local store (`.githaiku-dev/`) | TinyCloud Secrets via web-sdk |
| Secret reads | `SecretsProvider=local` | `tc-cli` (`@tinycloud/cli@0.7.0-beta.1`, real `tc secrets get --delegation`) — `GITHAIKU_SECRETS_PROVIDER=tc-cli` (**wired**; needs a node + backend key + stored delegation, else fails loudly) |
| Haiku generation | Deterministic template (default) | Anthropic via owner key — `GITHAIKU_USE_ANTHROPIC=1` (stubbed seam) |
| GitHub token | Optional; falls back to a labeled dev fixture | Required, from owner's stored token |
| `proof` block | Dev placeholder (`image_digest`/`attestation_url` = `null`) | dstack TEE attestation (`/attestation` is a stub) |
| Owner auth | Local session (none) | OpenKey sign-in (seam left, untested e2e) |
| Requester surface | Web button | + MCP tool (deferred) |

The dev fallbacks are **explicit, labeled product behavior**, not error masking.
Selecting a deferred provider (e.g. `tc-cli`) throws loudly rather than silently
degrading.

## Layout

- `packages/shared` — egress schema (single source of truth) + output guard.
- `packages/backend` — Fastify API: `POST /api/owner`, `POST /api/haiku`,
  `GET /health`, `GET /attestation` (stub), plus (tc-cli provider only)
  `GET /api/server-info` (backend DID + the policy owners must delegate) and
  `POST /api/delegations` (receive + validate + store an owner delegation).
  `SecretsProvider` interface (`local` + real `tc-cli`), backend identity
  (`identity.ts`, stable did:pkh; dstack key is a seam), per-owner delegation
  store, commit-messages-only GitHub adapter, deterministic haiku core.
- `packages/frontend` — Vite + React: requester page (hero) + owner setup page;
  proxies `/api` to the backend.

## Useful flags / env

| Env | Default | Effect |
|---|---|---|
| `PORT` | `8787` | Backend port |
| `GITHAIKU_SECRETS_PROVIDER` | `local` | `local` or `tc-cli` (real delegated reads) |
| `GITHAIKU_BACKEND_PRIVATE_KEY` | _(none)_ | tc-cli only: backend stable identity; its did:pkh is the delegation audience |
| `GITHAIKU_NODE_HOST` | `https://node.tinycloud.xyz` | TinyCloud node for the backend identity + delegated reads |
| `GITHAIKU_USE_ANTHROPIC` | `false` | Use Anthropic generator (deferred) |
| `GITHAIKU_MAX_COMMITS` | `30` | GitHub commit cap |
| `GITHAIKU_WINDOW_DAYS` | `30` | GitHub time window |

## Test & build

```bash
pnpm test    # shared (guard, incl. sanitize-before-validate) + backend (egress flow)
pnpm build   # typecheck backend + build frontend
```

### Live delegated-secrets integration (real node, gated)

Proves the real tc-cli path end-to-end against a **local** tinycloud-node: a
throwaway owner puts both secrets, delegates KV-get + decrypt to the backend's
stable `did:pkh`, delivers the delegation (`POST /api/delegations`), and the
backend reads both secrets via the real `tc` CLI. Not part of `pnpm test`.

```bash
GITHAIKU_LIVE=1 pnpm --filter @githaiku/backend test:live
# optional: GITHAIKU_LIVE_GITHUB_TOKEN=<real ro token> GITHAIKU_LIVE_GITHUB_LOGIN=<login>
#           GITHAIKU_NODE_BIN=<path to tinycloud binary> GITHAIKU_LIVE_PORT=<port>
```
