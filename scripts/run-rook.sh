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
RUN_ROOT="$REPO_ROOT/.var/run-rook"
BUILD_ROOT="$RUN_ROOT/build"
SERVER_LOG="$RUN_ROOT/server.log"
SERVER_PIDFILE="$RUN_ROOT/server.pid"
SERVER_PORT="${ROOK_SERVER_PORT:-3000}"
SERVER_BIND_HOST="127.0.0.1"
SERVER_HEALTH_URL="http://${SERVER_BIND_HOST}:${SERVER_PORT}/api/health"
SERVER_AUTH_TOKEN="${ROOK_AUTH_TOKEN:-}"

mkdir -p "$RUN_ROOT" "$BUILD_ROOT"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-rook.sh server
  ./scripts/run-rook.sh mac
  ./scripts/run-rook.sh sim [--simulator NAME_OR_UDID] [--reset-permissions]
  ./scripts/run-rook.sh phone [--device NAME_OR_UDID] [--team TEAM_ID] [--reset-permissions]
  ./scripts/run-rook.sh mac sim
  ./scripts/run-rook.sh server mac sim
  ./scripts/run-rook.sh stop

What it does:
  - starts the Rook server if needed
  - regenerates Xcode projects from project.yml
  - rebuilds the selected app(s) incrementally
  - launches the selected target(s)

Notes:
  - you can pass multiple targets; they run in the order given
  - mac uses localhost by default
  - sim uses http://127.0.0.1:3000
  - phone uses ROOK_REMOTE_HOSTNAME, ROOK_BIND_IP, or a non-localhost ROOK_SERVER_HOST
  - the server always binds localhost; ROOK_BIND_IP adds a second remote listener
  - the server runs as a detached background process and logs to .var/run-rook/server.log
  - phone builds are intentionally NOT committed with a fixed team id;
    pass --team / ROOK_IOS_DEVELOPMENT_TEAM or let the script auto-detect
    your local Apple Development team from Keychain when possible.
  - stop shuts down the server, mac app, simulator app, booted simulators,
    and the phone app when reachable.
  - --reset-permissions clears the app's privacy grants (location, motion, mic,
    speech) so the OS prompts reappear next launch. On sim it resets via
    `simctl privacy` (sim already reinstalls each run); on phone it uninstalls
    the app first (the only way to reset device grants), so you re-grant from
    scratch — useful for testing the location/motion permission flow.
EOF
}

stop_everything() {
  log "stopping managed Rook resources"

  if [[ -f "$SERVER_PIDFILE" ]]; then
    local pid
    pid="$(cat "$SERVER_PIDFILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" || true
    fi
    rm -f "$SERVER_PIDFILE"
  fi

  local pids
  pids="$(lsof -tiTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids || true
  fi

  pkill -f Rook 2>/dev/null || true

  local booted
  booted="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin).get("devices",{}); ids=[]
for _,arr in d.items():
  ids += [x["udid"] for x in arr if x.get("state")=="Booted"]
print("\\n".join(ids))' 2>/dev/null || true)"
  if [[ -n "$booted" ]]; then
    while IFS= read -r udid; do
      [[ -n "$udid" ]] || continue
      xcrun simctl terminate "$udid" com.rookery.Rook 2>/dev/null || true
      xcrun simctl shutdown "$udid" 2>/dev/null || true
    done <<< "$booted"
  fi

  local tmp udid
  tmp="$(mktemp)"
  if xcrun devicectl list devices -j "$tmp" >/dev/null 2>&1; then
    udid="$(python3 - <<'PY' "$tmp"
import json,sys
with open(sys.argv[1]) as f:data=json.load(f)
for d in data.get('result',{}).get('devices',[]):
    hw=d.get('hardwareProperties',{})
    conn=d.get('connectionProperties',{})
    if hw.get('platform')=='iOS' and hw.get('reality')=='physical' and conn.get('pairingState')=='paired':
        print(hw.get('udid',''))
        break
PY
)"
    if [[ -n "$udid" ]]; then
      xcrun devicectl device process terminate --device "$udid" "$DEFAULT_IOS_APP_BUNDLE_ID" >/dev/null 2>&1 || true
      local stop_team stop_bundle_id _stop_widget_id _stop_test_id
      stop_team="${TEAM_ID:-}"
      if [[ -z "$stop_team" ]]; then
        stop_team="$(auto_detect_team 2>/dev/null || true)"
      fi
      if [[ -n "$stop_team" ]]; then
        IFS=$'\t' read -r stop_bundle_id _stop_widget_id _stop_test_id <<<"$(phone_bundle_ids "$stop_team")"
        xcrun devicectl device process terminate --device "$udid" "$stop_bundle_id" >/dev/null 2>&1 || true
      fi
    fi
  fi
  rm -f "$tmp"

  log "stopped server, mac app, simulator app(s), booted simulators, and phone app if present"
}

log() { echo "[run-rook] $*"; }
warn() { echo "[run-rook] warning: $*" >&2; }
die() { echo "[run-rook] error: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

TARGETS=()
SIMULATOR_FILTER=""
DEVICE_FILTER=""
TEAM_ID="${ROOK_IOS_DEVELOPMENT_TEAM:-}"
RESET_PERMISSIONS=0
DEFAULT_IOS_APP_BUNDLE_ID="com.rookery.Rook"
DEFAULT_IOS_WIDGET_BUNDLE_ID="${DEFAULT_IOS_APP_BUNDLE_ID}.RookWidgets"
DEFAULT_IOS_TEST_BUNDLE_ID="com.rookery.RookTests"

while [[ $# -gt 0 ]]; do
  case "$1" in
    server|mac|sim|phone|stop)
      TARGETS+=("$1")
      shift
      ;;
    --reset-permissions)
      RESET_PERMISSIONS=1
      shift
      ;;
    --simulator)
      SIMULATOR_FILTER="${2:-}"
      shift 2
      ;;
    --device)
      DEVICE_FILTER="${2:-}"
      shift 2
      ;;
    --team)
      TEAM_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ ${#TARGETS[@]} -gt 0 ]] || { usage; exit 2; }

HAS_SERVER_TARGET=0
HAS_PHONE_TARGET=0
for target in "${TARGETS[@]}"; do
  case "$target" in
    server) HAS_SERVER_TARGET=1 ;;
    phone) HAS_PHONE_TARGET=1 ;;
    stop) ;;
  esac
done

if (( ${#TARGETS[@]} > 1 )); then
  for target in "${TARGETS[@]}"; do
    if [[ "$target" == "stop" ]]; then
      die "stop must be used by itself"
    fi
  done
fi

need_cmd curl
need_cmd python3
need_cmd lsof

HAS_MAC_TARGET=0
HAS_SIM_TARGET=0
for target in "${TARGETS[@]}"; do
  case "$target" in
    mac) HAS_MAC_TARGET=1 ;;
    sim) HAS_SIM_TARGET=1 ;;
  esac
done

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

health_ok() {
  local -a curl_args=(--silent --show-error --fail)
  if [[ -n "$SERVER_AUTH_TOKEN" ]]; then
    curl_args+=( -H "Authorization: Bearer $SERVER_AUTH_TOKEN" )
  fi
  curl "${curl_args[@]}" "$SERVER_HEALTH_URL" >/dev/null 2>&1
}

listener_is_localhost_only() {
  local out
  out="$(lsof -nP -iTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$out" ]] || return 1
  if grep -Eq '(localhost:|127\.0\.0\.1:)' <<<"$out" \
    && ! grep -Eq '(\*:|0\.0\.0\.0:|\[::\]:)' <<<"$out" \
    && ! grep -Eq '(^|[[:space:]])(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|100\.)' <<<"$out"; then
    return 0
  fi
  return 1
}

kill_server_if_owned() {
  if [[ -f "$SERVER_PIDFILE" ]]; then
    local pid
    pid="$(cat "$SERVER_PIDFILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      log "stopping server pid $pid"
      kill "$pid" || true
      sleep 1
    fi
    rm -f "$SERVER_PIDFILE"
  fi
}

kill_server_on_port() {
  local pids
  pids="$(lsof -tiTCP:"$SERVER_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0
  log "stopping existing listener(s) on port ${SERVER_PORT}: $(echo "$pids" | tr '\n' ' ')"
  kill $pids || true
  sleep 1
}

stop_mac_app() {
  if pgrep -f Rook >/dev/null 2>&1; then
    log "stopping existing Rook mac app"
    pkill -f Rook || true
    sleep 1
  fi
}

stop_simulators() {
  need_cmd xcrun
  local booted
  booted="$(xcrun simctl list devices booted -j 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin).get("devices",{}); ids=[]
for _,arr in d.items():
  ids += [x["udid"] for x in arr if x.get("state")=="Booted"]
print("\\n".join(ids))' 2>/dev/null || true)"
  [[ -n "$booted" ]] || return 0
  log "stopping existing simulator app(s) and booted simulators"
  while IFS= read -r udid; do
    [[ -n "$udid" ]] || continue
    xcrun simctl terminate "$udid" com.rookery.Rook 2>/dev/null || true
    xcrun simctl shutdown "$udid" 2>/dev/null || true
  done <<< "$booted"
}

stop_requested_targets() {
  (( HAS_MAC_TARGET )) && stop_mac_app
  (( HAS_SIM_TARGET )) && stop_simulators
  if (( HAS_SERVER_TARGET )); then
    kill_server_if_owned
    kill_server_on_port
  fi
}

wait_for_health() {
  local attempts=${1:-60}
  local i
  for ((i=1; i<=attempts; i++)); do
    if health_ok; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_server_in_background() {
  need_cmd npm
  log "starting server in background (log: $SERVER_LOG)"
  (
    cd "$REPO_ROOT"
    nohup npm run dev >"$SERVER_LOG" 2>&1 &
    echo $! >"$SERVER_PIDFILE"
  )
}

ensure_server_deps() {
  local server_dir="$REPO_ROOT/server"
  if [[ -d "$server_dir/node_modules" ]] && [[ -f "$server_dir/node_modules/tsx/dist/cli.mjs" ]]; then
    return 0
  fi
  need_cmd npm
  log "installing server dependencies (npm install)"
  (cd "$server_dir" && npm install --no-audit --no-fund)
}

start_server() {
  if health_ok; then
    log "server already healthy at ${SERVER_HEALTH_URL}"
  else
    if lsof -nP -iTCP:"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      die "port ${SERVER_PORT} is already in use, but /api/health is not healthy"
    fi
    ensure_server_deps
    start_server_in_background
    if ! wait_for_health 90; then
      tail -n 80 "$SERVER_LOG" >&2 || true
      die "server did not become healthy"
    fi
    log "server is healthy"
  fi

  if (( HAS_PHONE_TARGET )) && listener_is_localhost_only; then
    die "server is only listening on localhost; restart it so the phone can reach your Mac over your chosen remote network"
  fi
}

ensure_xcode_project() {
  local app_dir="$1"
  local project_path="$2"
  if ! command -v xcodegen >/dev/null 2>&1; then
    [[ -d "$project_path" ]] || die "missing $project_path and xcodegen is not installed (brew install xcodegen)"
    return
  fi
  log "generating $(basename "$project_path") from project.yml"
  (
    cd "$app_dir"
    xcodegen generate >/dev/null
  )
}

patch_iphone_project_bundle_ids() {
  local project_path="$1"
  local app_id="$2"
  local widget_id="$3"
  local test_id="$4"
  python3 - <<'PY' "$project_path/project.pbxproj" "$app_id" "$widget_id" "$test_id"
from pathlib import Path
import sys
pbxproj = Path(sys.argv[1])
app_id, widget_id, test_id = sys.argv[2:5]
text = pbxproj.read_text()
text = text.replace("PRODUCT_BUNDLE_IDENTIFIER = com.rookery.Rook.RookWidgets;", f"PRODUCT_BUNDLE_IDENTIFIER = {widget_id};")
text = text.replace("PRODUCT_BUNDLE_IDENTIFIER = com.rookery.RookTests;", f"PRODUCT_BUNDLE_IDENTIFIER = {test_id};")
text = text.replace("PRODUCT_BUNDLE_IDENTIFIER = com.rookery.Rook;", f"PRODUCT_BUNDLE_IDENTIFIER = {app_id};")
pbxproj.write_text(text)
PY
}

sanitize_bundle_segment() {
  local raw="$1"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  [[ -n "$raw" ]] || raw="dev"
  printf '%s' "$raw"
}

phone_bundle_ids() {
  local team="$1"
  local team_segment
  team_segment="$(sanitize_bundle_segment "$team")"
  local app_id="com.rookery.${team_segment}.Rook"
  local widget_id="${app_id}.RookWidgets"
  local test_id="com.rookery.${team_segment}.RookTests"
  printf '%s\t%s\t%s\n' "$app_id" "$widget_id" "$test_id"
}

current_remote_target() {
  if [[ -n "${ROOK_REMOTE_HOSTNAME:-}" ]]; then
    printf '%s\n' "$ROOK_REMOTE_HOSTNAME"
    return 0
  fi
  if [[ -n "${ROOK_BIND_IP:-}" ]]; then
    printf '%s\n' "$ROOK_BIND_IP"
    return 0
  fi
  if [[ -n "${ROOK_SERVER_HOST:-}" ]] && [[ "$ROOK_SERVER_HOST" != "127.0.0.1" ]] && [[ "$ROOK_SERVER_HOST" != "localhost" ]]; then
    printf '%s\n' "$ROOK_SERVER_HOST"
    return 0
  fi
  return 1
}

resolve_simulator() {
  xcrun simctl list devices available -j | python3 -c '
import json,sys
want=sys.argv[1].strip().lower()
data=json.load(sys.stdin)
cands=[]
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for d in devices:
        if not d.get("isAvailable", False):
            continue
        name=d["name"]
        udid=d["udid"]
        state=d.get("state","Shutdown")
        rec=(name,udid,state)
        if want:
            hay=f"{name} {udid}".lower()
            if want in hay:
                print(f"{name}\t{udid}\t{state}")
                raise SystemExit(0)
        cands.append(rec)
for name,udid,state in cands:
    if state == "Booted" and "iPhone" in name:
        print(f"{name}\t{udid}\t{state}")
        raise SystemExit(0)
for preferred in ("iPhone 17 Pro", "iPhone 16 Pro", "iPhone 15 Pro"):
    for name,udid,state in cands:
        if name == preferred:
            print(f"{name}\t{udid}\t{state}")
            raise SystemExit(0)
for name,udid,state in cands:
    if "iPhone" in name:
        print(f"{name}\t{udid}\t{state}")
        raise SystemExit(0)
raise SystemExit(1)
' "$SIMULATOR_FILTER"
}

resolve_phone() {
  local tmp
  tmp="$(mktemp)"
  xcrun devicectl list devices -j "$tmp" >/dev/null
  python3 - <<'PY' "$tmp" "$DEVICE_FILTER"
import json,sys
path,want=sys.argv[1],sys.argv[2].strip().lower()
with open(path) as f:
    data=json.load(f)
rows=[]
for d in data.get('result', {}).get('devices', []):
    hw=d.get('hardwareProperties', {})
    conn=d.get('connectionProperties', {})
    props=d.get('deviceProperties', {})
    if hw.get('platform') != 'iOS' or hw.get('reality') != 'physical':
        continue
    if conn.get('pairingState') != 'paired':
        continue
    name=props.get('name') or hw.get('productType') or 'Unknown iPhone'
    udid=hw.get('udid') or d.get('identifier')
    rows.append((name,udid))
if want:
    matches=[r for r in rows if want in f"{r[0]} {r[1]}".lower()]
    if len(matches)==1:
        print(f"{matches[0][0]}\t{matches[0][1]}")
        raise SystemExit(0)
    if len(matches)>1:
        print('MULTIPLE', file=sys.stderr)
        for name,udid in matches:
            print(f"- {name} ({udid})", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(1)
if len(rows)==1:
    print(f"{rows[0][0]}\t{rows[0][1]}")
    raise SystemExit(0)
if len(rows)>1:
    print('MULTIPLE', file=sys.stderr)
    for name,udid in rows:
        print(f"- {name} ({udid})", file=sys.stderr)
    raise SystemExit(2)
raise SystemExit(1)
PY
  local status=$?
  rm -f "$tmp"
  return "$status"
}

auto_detect_team() {
  local ids=""
  local prov_paths=()
  while IFS= read -r path; do
    prov_paths+=("$path")
  done < <(find "$HOME/Library/Developer/Xcode/DerivedData" "$HOME/Library/MobileDevice/Provisioning Profiles" \
    \( -path '*/Rook.app/embedded.mobileprovision' -o -name '*.mobileprovision' \) 2>/dev/null)

  if [[ ${#prov_paths[@]} -gt 0 ]]; then
    ids="$(python3 - <<'PY' "${prov_paths[@]}"
import plistlib, subprocess, sys
ids=set()
for path in sys.argv[1:]:
    try:
        xml=subprocess.check_output(["security", "cms", "-D", "-i", path], stderr=subprocess.DEVNULL)
        plist=plistlib.loads(xml)
        for team in plist.get("TeamIdentifier", []):
            if team:
                ids.add(team.upper())
    except Exception:
        pass
print("\n".join(sorted(ids)))
PY
)"
  fi

  if [[ -z "${ids//[$'\n\r\t ']/}" ]]; then
    ids="$(security find-certificate -a -c "Apple Development" 2>/dev/null | python3 -c '
import re,sys
text=sys.stdin.read()
ids=sorted({match.upper() for match in re.findall(r"Apple Development: .* \(([^)]+)\)", text)})
print("\\n".join(ids))
')"
  fi

  ids="$(printf '%s\n' "$ids" | sed '/^$/d' || true)"
  local count
  count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" == "1" ]]; then
    printf '%s' "$ids"
    return 0
  fi
  return 1
}

build_mac() {
  need_cmd xcodebuild
  local app_dir="$REPO_ROOT/clients/mac"
  local proj="$app_dir/Rook.xcodeproj"
  local derived="$BUILD_ROOT/Rook"
  ensure_xcode_project "$app_dir" "$proj"
  stop_mac_app
  log "building Rook"
  xcodebuild -project "$proj" -scheme Rook -configuration Debug -derivedDataPath "$derived" build >/dev/null
  local app_path="$derived/Build/Products/Debug/Rook.app"
  [[ -d "$app_path" ]] || die "missing built app: $app_path"
  local url="http://127.0.0.1:${SERVER_PORT}"
  log "launching Rook with ROOK_SERVER_BASE_URL=$url"
  if [[ -n "$SERVER_AUTH_TOKEN" ]]; then
    ROOK_SERVER_BASE_URL="$url" ROOK_AUTH_TOKEN="$SERVER_AUTH_TOKEN" "$app_path/Contents/MacOS/Rook" >/dev/null 2>&1 &
  else
    ROOK_SERVER_BASE_URL="$url" "$app_path/Contents/MacOS/Rook" >/dev/null 2>&1 &
  fi
}

build_sim() {
  need_cmd xcodebuild
  need_cmd xcrun
  need_cmd open
  local sim
  if ! sim="$(resolve_simulator)"; then
    die "no available iPhone simulator found"
  fi
  local sim_name sim_udid sim_state
  IFS=$'\t' read -r sim_name sim_udid sim_state <<<"$sim"
  log "using simulator: $sim_name ($sim_udid)"
  open -a Simulator >/dev/null 2>&1 || true
  if [[ "$sim_state" != "Booted" ]]; then
    xcrun simctl boot "$sim_udid" >/dev/null 2>&1 || true
  fi
  xcrun simctl bootstatus "$sim_udid" -b >/dev/null

  local app_dir="$REPO_ROOT/clients/iphone"
  local proj="$app_dir/Rook.xcodeproj"
  local derived="$BUILD_ROOT/Rook-sim"
  ensure_xcode_project "$app_dir" "$proj"
  log "building Rook for simulator"
  xcodebuild -project "$proj" -scheme Rook -configuration Debug -destination "id=$sim_udid" -derivedDataPath "$derived" build >/dev/null
  local app_path="$derived/Build/Products/Debug-iphonesimulator/Rook.app"
  [[ -d "$app_path" ]] || die "missing built app: $app_path"

  local url="http://127.0.0.1:${SERVER_PORT}"
  if (( RESET_PERMISSIONS )); then
    log "resetting simulator privacy permissions for com.rookery.Rook"
    xcrun simctl privacy "$sim_udid" reset all com.rookery.Rook >/dev/null 2>&1 || true
  fi
  log "refreshing simulator install for Rook"
  xcrun simctl terminate "$sim_udid" com.rookery.Rook >/dev/null 2>&1 || true
  xcrun simctl uninstall "$sim_udid" com.rookery.Rook >/dev/null 2>&1 || true
  xcrun simctl install "$sim_udid" "$app_path" >/dev/null
  log "launching Rook in simulator with ROOK_SERVER_BASE_URL=$url"
  local launch_output
  if [[ -n "$SERVER_AUTH_TOKEN" ]]; then
    launch_output="$(SIMCTL_CHILD_ROOK_SERVER_BASE_URL="$url" \
      SIMCTL_CHILD_ROOK_AUTH_TOKEN="$SERVER_AUTH_TOKEN" \
      xcrun simctl launch --terminate-running-process "$sim_udid" com.rookery.Rook)"
  else
    launch_output="$(SIMCTL_CHILD_ROOK_SERVER_BASE_URL="$url" \
      xcrun simctl launch --terminate-running-process "$sim_udid" com.rookery.Rook)"
  fi
  log "$launch_output"
}

build_phone() {
  need_cmd xcodebuild
  need_cmd xcrun
  local phone
  if ! phone="$(resolve_phone)"; then
    die "no paired physical iPhone found; plug one in, unlock it, trust this Mac, and enable developer mode if prompted"
  fi
  local phone_name phone_udid
  IFS=$'\t' read -r phone_name phone_udid <<<"$phone"
  log "using device: $phone_name ($phone_udid)"

  if [[ -z "$TEAM_ID" ]]; then
    if TEAM_ID="$(auto_detect_team)"; then
      warn "using local Apple Development team $TEAM_ID from Keychain; teammates should pass --team or ROOK_IOS_DEVELOPMENT_TEAM"
    else
      die "could not auto-detect a single Apple Development team; pass --team TEAM_ID or export ROOK_IOS_DEVELOPMENT_TEAM"
    fi
  fi

  local url
  local remote_target
  remote_target="$(current_remote_target)"
  if [[ -z "$remote_target" ]]; then
    cat >&2 <<EOF
[run-rook] error: could not determine a reachable server address for the phone
[run-rook] set one of:
[run-rook]   ROOK_REMOTE_HOSTNAME=your-hostname
[run-rook]   ROOK_BIND_IP=your.remote.ip
[run-rook] example with Tailscale:
[run-rook]   ROOK_REMOTE_HOSTNAME=your-mac.tailxxxx.ts.net
EOF
    exit 1
  fi
  url="http://${remote_target}:${SERVER_PORT}"

  local app_dir="$REPO_ROOT/clients/iphone"
  local proj="$app_dir/Rook.xcodeproj"
  local derived="$BUILD_ROOT/Rook-phone"
  local phone_app_bundle_id phone_widget_bundle_id phone_test_bundle_id
  IFS=$'\t' read -r phone_app_bundle_id phone_widget_bundle_id phone_test_bundle_id <<<"$(phone_bundle_ids "$TEAM_ID")"
  log "using phone bundle ids: $phone_app_bundle_id (+ widget/test variants)"
  ensure_xcode_project "$app_dir" "$proj"
  patch_iphone_project_bundle_ids "$proj" "$phone_app_bundle_id" "$phone_widget_bundle_id" "$phone_test_bundle_id"
  log "building Rook for $phone_name"
  local build_log="$RUN_ROOT/rook-phone-build.log"
  if ! xcodebuild \
    -project "$proj" \
    -scheme Rook \
    -configuration Debug \
    -destination "id=$phone_udid" \
    -derivedDataPath "$derived" \
    -allowProvisioningUpdates \
    -allowProvisioningDeviceRegistration \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    build >"$build_log" 2>&1; then
    tail -n 80 "$build_log" >&2 || true
    die "iPhone build failed (full log: $build_log)"
  fi

  local app_path="$derived/Build/Products/Debug-iphoneos/Rook.app"
  [[ -d "$app_path" ]] || die "missing built app: $app_path"

  if (( RESET_PERMISSIONS )); then
    log "uninstalling Rook on $phone_name to reset its privacy permissions"
    xcrun devicectl device uninstall app --device "$phone_udid" "$phone_app_bundle_id" >/dev/null 2>&1 || true
  fi
  log "installing Rook on $phone_name"
  xcrun devicectl device install app --device "$phone_udid" "$app_path" >/dev/null
  log "launching Rook on $phone_name with ROOK_SERVER_BASE_URL=$url"
  local launch_env
  if [[ -n "$SERVER_AUTH_TOKEN" ]]; then
    launch_env="{\"ROOK_SERVER_BASE_URL\":$(json_escape "$url"),\"ROOK_AUTH_TOKEN\":$(json_escape "$SERVER_AUTH_TOKEN")}"
  else
    launch_env="{\"ROOK_SERVER_BASE_URL\":$(json_escape "$url")}"
  fi
  local launch_log="$RUN_ROOT/rook-phone-launch.log"
  if ! xcrun devicectl device process launch \
    --device "$phone_udid" \
    --terminate-existing \
    -e "$launch_env" \
    "$phone_app_bundle_id" >"$launch_log" 2>&1; then
    if grep -qiE 'explicitly trusted by the user|invalid code signature|inadequate entitlements' "$launch_log"; then
      cat "$launch_log" >&2 || true
      die "iPhone launch failed because the developer app certificate is not yet trusted on $phone_name; trust it in Settings -> General -> VPN & Device Management, then run ./scripts/run-rook.sh phone again"
    fi
    if grep -qiE 'Locked|could not be unlocked' "$launch_log"; then
      cat "$launch_log" >&2 || true
      die "iPhone launch failed because $phone_name is locked; unlock the phone and run ./scripts/run-rook.sh phone again"
    fi
    tail -n 80 "$launch_log" >&2 || true
    die "iPhone launch failed (full log: $launch_log)"
  fi

  cat <<EOF
[run-rook] launched on $phone_name
[run-rook] server URL: $url
[run-rook] if iOS says the developer certificate is untrusted:
[run-rook]   Settings -> General -> VPN & Device Management -> trust your developer app certificate
EOF
}

if [[ "${TARGETS[0]}" == "stop" ]]; then
  stop_everything
  exit 0
fi

stop_requested_targets
start_server

for TARGET in "${TARGETS[@]}"; do
  case "$TARGET" in
    server)
      log "server ready: ${SERVER_HEALTH_URL%/api/health}"
      ;;
    mac)
      build_mac
      ;;
    sim)
      build_sim
      ;;
    phone)
      build_phone
      ;;
  esac
done
