#!/usr/bin/env bash
# Stand up the tc-cli stack for the OpenKey full-flow E2E:
#   - local tinycloud-node (Static keys)
#   - backend with GITHAIKU_SECRETS_PROVIDER=tc-cli
#   - portless frontend (https://githaiku.localhost)
#
# Then, in another shell with a captured e2e/.passkey.json:
#   cd e2e && bun full-flow.ts
#
# Stop with Ctrl-C (kills the node + leaves portless for you to stop).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${GITHAIKU_NODE_BIN:-/Users/samgbafa/Documents/github/tinycloud-dev/repositories/tinycloud-node/target/debug/tinycloud}"
PORT="${GITHAIKU_NODE_PORT:-8799}"
DATADIR="$(mktemp -d -t githaiku-node-XXXX)"
# Throwaway anvil-style backend key (local only). The owner key lives in OpenKey.
BACKEND_KEY_ENV="GITHAIKU_BACKEND_PRIVATE_KEY"
if [[ -z "${!BACKEND_KEY_ENV:-}" ]]; then
  printf -v "${BACKEND_KEY_ENV}" '%s' "0x8b3a350cf5c34c9194ca3a545d9f2bc5b642b3ee6cca3a637f1d2d1765f37c13"
fi
export "${BACKEND_KEY_ENV}"
export GITHAIKU_SECRETS_PROVIDER=tc-cli
export GITHAIKU_NODE_HOST="http://127.0.0.1:${PORT}"

cat > "${DATADIR}/tinycloud.toml" <<'TOML'
[global.keys]
type = "Static"
TOML

echo "[stack] node datadir: ${DATADIR}"
echo "[stack] node host:    ${GITHAIKU_NODE_HOST}"
echo "[stack] starting tinycloud-node…"
( cd "${DATADIR}" && TINYCLOUD_LOG_LEVEL=normal TINYCLOUD_PORT="${PORT}" \
    TINYCLOUD_STORAGE_DATADIR="${DATADIR}/store" TINYCLOUD_CORS=true "${NODE_BIN}" ) &
NODE_PID=$!
trap 'kill ${NODE_PID} 2>/dev/null || true' EXIT

# Wait for the node.
for _ in $(seq 1 60); do
  if curl -fsS "${GITHAIKU_NODE_HOST}/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "[stack] node up: $(curl -fsS "${GITHAIKU_NODE_HOST}/version" 2>/dev/null | head -c 120)"

echo "[stack] starting portless frontend + backend (tc-cli mode)…"
echo "[stack] backend reads GITHAIKU_SECRETS_PROVIDER=${GITHAIKU_SECRETS_PROVIDER}"
cd "${ROOT}"
exec pnpm dev
