#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: tail-logs.sh [--instructions] [--tools]

Tails /tmp/pi-traces.jsonl (or $PI_TRACE_LOG) and prints new messages as
they appear. Each log line is a complete prompt sent to the LLM; only the
delta (messages not yet printed) is shown.

  --instructions   Pretty-print the system instructions when first seen
  --tools          Pretty-print tool definitions (YAML style) when first seen
EOF
  exit 0
fi

exec python3 -u "$SCRIPT_DIR/lib/tail-logs.py" "$@"
