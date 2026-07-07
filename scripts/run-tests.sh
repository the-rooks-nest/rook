#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[run-tests] $*"; }
die() { echo "[run-tests] error: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

need_cmd bash
need_cmd xcodebuild
need_cmd xcrun
need_cmd python3
need_cmd npm

if command -v xcodegen >/dev/null 2>&1; then
  log "generating iPhone Xcode project"
  (
    cd "$REPO_ROOT/clients/iphone"
    xcodegen generate >/dev/null
  )
fi

resolve_iphone_simulator() {
  xcrun simctl list devices available -j | python3 -c '
import json, sys
preferred = ["iPhone 17 Pro", "iPhone 17", "iPhone 16 Pro", "iPhone 16", "iPhone 15 Pro", "iPhone 15"]
data = json.load(sys.stdin).get("devices", {})
devices = []
for runtime, entries in data.items():
    if "iOS" not in runtime:
        continue
    for entry in entries:
        if entry.get("isAvailable"):
            devices.append((entry.get("name", ""), entry.get("udid", "")))
for wanted in preferred:
    for name, udid in devices:
        if name == wanted:
            print(udid)
            raise SystemExit(0)
for name, udid in devices:
    if name.startswith("iPhone"):
        print(udid)
        raise SystemExit(0)
raise SystemExit(1)
'
}

SIM_UDID="$(resolve_iphone_simulator)" || die "could not find an available iPhone simulator"
log "using iPhone simulator: $SIM_UDID"

declare -a FAILURES=()

run_step() {
  local name="$1"
  shift
  log "running $name"
  if "$@"; then
    log "$name passed"
  else
    local code=$?
    log "$name failed (exit $code)"
    FAILURES+=("$name (exit $code)")
  fi
}

run_step "server tests" bash -lc "cd '$REPO_ROOT/server' && npm test"
run_step "RookKit Swift package tests" bash -lc "cd '$REPO_ROOT/clients/RookKit' && swift test"
run_step "iPhone XCTest suite" xcodebuild \
  -project "$REPO_ROOT/clients/iphone/Rook.xcodeproj" \
  -scheme Rook \
  -configuration Debug \
  -destination "id=$SIM_UDID" \
  test
run_step "macOS build validation" xcodebuild \
  -project "$REPO_ROOT/clients/mac/Rook.xcodeproj" \
  -scheme Rook \
  -sdk macosx \
  -configuration Debug \
  build

if ((${#FAILURES[@]} > 0)); then
  log "failures:"
  for failure in "${FAILURES[@]}"; do
    log "  - $failure"
  done
  exit 1
fi

log "all tests passed"
