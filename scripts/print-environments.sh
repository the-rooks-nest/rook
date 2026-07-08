#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

SERVER_URL="${ROOK_SERVER_BASE_URL:-http://127.0.0.1:${ROOK_SERVER_PORT:-7665}}"
AUTH_TOKEN="${ROOK_AUTH_TOKEN:-}"
ENDPOINT_PATH="/api/diagnostics/environments"

usage() {
  cat <<EOF
Usage:
  ./scripts/print-environments.sh [--url URL] [--token TOKEN] [--raw]

Examples:
  ./scripts/print-environments.sh
  ./scripts/print-environments.sh --token "\$ROOK_AUTH_TOKEN"
  ./scripts/print-environments.sh --url http://127.0.0.1:7665 --raw

Auth:
  - if .env exists, ROOK_AUTH_TOKEN is loaded automatically
  - --token overrides ROOK_AUTH_TOKEN
EOF
}

RAW=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      SERVER_URL="${2:?missing value for --url}"
      shift 2
      ;;
    --token)
      AUTH_TOKEN="${2:?missing value for --token}"
      shift 2
      ;;
    --raw)
      RAW=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

need_cmd curl
if (( RAW == 0 )); then
  need_cmd jq
fi

URL="${SERVER_URL%/}${ENDPOINT_PATH}"
CURL_ARGS=(--silent --show-error --fail-with-body)
if [[ -n "$AUTH_TOKEN" ]]; then
  CURL_ARGS+=( -H "Authorization: Bearer $AUTH_TOKEN" )
fi

if ! response="$(curl "${CURL_ARGS[@]}" "$URL")"; then
  status=$?
  echo "request failed: $URL" >&2
  if [[ -z "$AUTH_TOKEN" ]]; then
    echo "hint: set ROOK_AUTH_TOKEN or pass --token" >&2
  fi
  exit "$status"
fi

if (( RAW == 1 )); then
  printf '%s\n' "$response"
  exit 0
fi

printf '%s\n' "$response" | jq '{counts, environments}'
