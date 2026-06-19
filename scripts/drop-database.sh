#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$REPO_ROOT/.var/agent-station/environment-decisions.sqlite"

rm -f "$DB_PATH"
"$SCRIPT_DIR/run-rook.sh" mac --restart-server
