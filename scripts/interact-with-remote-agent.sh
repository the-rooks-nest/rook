#!/usr/bin/env bash
# Exercise the remote-agent bridge without the web UI. Run from repo root:
#
#   ./scripts/interact-with-remote-agent.sh [options] <prompt>
#   npm run agent:cli -- [options] <prompt>
#
# Setup once: cd server && npm install
#
# Common flags: --agent PiAgent | MyPiOpenAiAgent | PirateClaudeAgent | CursorAutoAgent
#               --list-agents  --omit-deltas  --only <types>  --omit <types>
#               --steer '<text>'  --steer-after-ms 1500  --permission allow-once
#               --session '<json>'  --restart  --replay  --no-session  --no-replay  --raw-acp  --help
#
# Event output is ACP client events (acp_*) — see the interact-with-remote-agent.ts
# header for the full type list used by --omit / --only (--omit-deltas hides the
# message/thought/tool-input delta types).
#
# Full example:
#   ./scripts/interact-with-remote-agent.sh \
#     --agent MyPiOpenAiAgent \
#     --session '{"id":"8f2c1a40-9b3e-4d12-8c01-2a9f0e7d31b4","agent":"MyPiOpenAiAgent","name":"vault-chat","createdAt":"2026-06-02T18:30:00.000Z","restart":{"cwd":"/Users/me/vault"}}' \
#     --restart --replay --omit-deltas --omit status_changed,environment_event \
#     "Summarize our thread and list open tasks"
#
# Full documentation: see the header comment in interact-with-remote-agent.ts
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ROOT="$REPO_ROOT/server"
TSX="$SERVER_ROOT/node_modules/tsx/dist/cli.mjs"

if [[ ! -f "$TSX" ]]; then
  echo "Missing tsx. Install deps once:" >&2
  echo "  cd \"$SERVER_ROOT\" && npm install" >&2
  exit 1
fi

exec node "$TSX" --tsconfig "$SERVER_ROOT/tsconfig.json" "$SCRIPT_DIR/lib/interact-with-remote-agent/interact-with-remote-agent.ts" "$@"
