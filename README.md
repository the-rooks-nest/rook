# Rook

Monorepo for local Pi agents, an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/get-started/introduction)-oriented chat runtime, and host clients/providers.

ACP standardizes JSON-RPC between editors/clients and coding agents. Here, the browser (and macOS menu bar client) talk ACP over WebSocket to `:3000`; each agent runtime is an ACP stdio subprocess (`pi-acp`, Claude's `claude-agent-acp`, Cursor's `agent acp`, etc.). Product notes: [`PRODUCT/agent-client-protocol.md`](PRODUCT/agent-client-protocol.md).

## Top-level packages

| Package | Role |
|---------|------|
| [server](server/) | Backend/runtime package: Fastify API, session/runtime orchestration, environment manager, and ACP-backed agent adapters |
| [clients/](clients/) | Home for the remaining native clients |
| [clients/mac](clients/mac/) | Native SwiftUI macOS menu bar client with full chat/session/environment support; also registers `app:<slug>` environments based on the frontmost Mac app |
| [clients/iphone](clients/iphone/) | Native SwiftUI iPhone client that registers `place:<slug>` environments from geofences and adds Live Activity / Dynamic Island + voice support |
| [clients/RookKit](clients/RookKit/) | Shared cross-platform Swift package (iOS + macOS): models, REST/ACP-WebSocket clients, design system/chat views, voice, and Live Activity attributes |
| [dummy-client](dummy-client/) | Port-3000 postMessage debug stub |

External dependency: a sibling Pi agent package at `../my-agent/` (not checked into this repo) provides the agent/skill environment referenced by the default Pi profile.

Use the package READMEs above as the main lookup docs for each area. Repo docs now live in [`docs/`](docs/), starting with [`docs/configuration.md`](docs/configuration.md).

## Quick start
1. Install **pi.dev / Pi** first, and make sure the `pi` CLI is on your `PATH`.
   Rook's ACP-backed Pi adapter still shells out to `pi`; without that install, Pi agents will not start.
2. Make sure the sibling agent package exists at `../my-agent/`.
   This repo expects that path relative to `server/`, so the default profile resolves it as `rookery_ai/server/../my-agent`.
3. Install the backend deps:
   ```bash
   cd server && npm install
   ```
4. From the repo root, start the main dev stack:
   ```bash
   npm run dev
   ```
   Or use the unified launcher:
   ```bash
   ./scripts/run-rook.sh server   # server only
   ./scripts/run-rook.sh mac      # server + macOS menu bar app
   ./scripts/run-rook.sh sim      # server + iPhone simulator app
   ./scripts/run-rook.sh phone    # server + physical iPhone app
   ./scripts/run-rook.sh stop     # stop server + launched apps/simulators
   ```
   On macOS, `run-rook.sh` now starts the server in Terminal.app so Pi keeps
   Terminal's Downloads/Desktop/Documents permissions instead of losing them in
   a detached `nohup` process.
5. The server listens on `http://127.0.0.1:3000`

## iPhone + home server onboarding with Tailscale

Rook works well as a "phone client talks to an always-on home agent" setup.
A common arrangement is:

- a spare Mac, Mac mini, or laptop at home runs the Rook server
- your iPhone runs the native Rook client
- both devices join the same [Tailscale](https://tailscale.com/) tailnet
- the iPhone connects to the server through the Mac's Tailscale MagicDNS name

Typical setup flow:

1. Create a Tailscale account.
2. Install the Tailscale app on the Mac that will host the Rook server.
3. Install the Tailscale app on your iPhone.
4. Sign both devices into the same tailnet.
5. In Tailscale, note the Mac's MagicDNS hostname (something like
   `your-mac.tailxxxx.ts.net`).
6. Start the Rook server on the Mac.
7. Point the iPhone client at `http://<your-mac>.ts.net:3000`.

The `./scripts/run-rook.sh phone` launcher is set up for exactly this flow: it
launches the iPhone app using the Mac's Tailscale MagicDNS hostname by default.
Once both devices are on Tailscale, the phone can talk securely to the server
from anywhere with internet access — not just when both are on the same Wi-Fi.

Quick troubleshooting:

- On the iPhone, open Safari and visit:
  - `http://<your-mac>.ts.net:3000/api/health`
- Expected response:
  - `{"ok":true,"service":"rook"}`
- If Safari works but the app does not, confirm the Rook app's server setting is
  exactly the same URL and reinstall/relaunch the app if needed.
- If Safari does not work, the problem is almost certainly Tailscale setup,
  device membership, or whether the server is actually running on the Mac.

## Pi agent configuration
Default user config lives in:
- `~/.rook/config/agent-profiles.json`

More detail: [`docs/configuration.md`](docs/configuration.md)

Current default profile:
```json
{
  "id": "MyPiAgent",
  "type": "pi",
  "parentId": "PiAgent",
  "args": ["-e", "../my-agent"]
}
```

Built-in agent parents now include:
- `PiAgent`
- `ClaudeAgent`

What that means:
- `id`: the agent name shown in Rook
- `type: "pi"`: use the built-in Pi-flavored ACP launcher
- `type: "claude"`: use the built-in Claude-flavored ACP launcher
- `parentId: "PiAgent"`: group this profile under the built-in Pi agent
- `args`: extra arguments passed to `pi` before `pi-acp` adds its RPC/session flags

The important bit is:
- Rookery now talks to Pi through **ACP**, not Pi RPC directly
- `-e ../my-agent` still points Pi at the sibling agent package directory
- the Pi launch helper is now generated internally at runtime; there is no checked-in wrapper script to maintain

## `../my-agent/` layout
`../my-agent/` is a separate sibling package, not part of this repo. Rook expects it to be your Pi agent/skills workspace.

Typical responsibilities there:
- agent instructions/prompts
- installed or custom skills
- skill metadata and implementations
- any Pi-specific config that belongs to the agent package itself

In short:
- configure **which Pi agent package to launch** in `~/.rook/config/agent-profiles.json`
- configure **the contents of that agent package** inside `../my-agent/`

If you move or rename the sibling package, update `args` in `agent-profiles.json` accordingly.

## Helpful scripts
- `./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"` — exercise the server/client bridge without the web UI
- `./scripts/interact-with-remote-agent.sh --raw-acp --agent PiAgent "hello"` — inspect raw ACP JSON-RPC traffic on the bridge
- `./scripts/run-rook.sh server` — start the server only (or reuse the running one); on macOS this opens it in Terminal.app by default to preserve protected-folder access for Pi
- `./scripts/run-rook.sh mac` — start the server if needed, rebuild, and launch the macOS menu bar app
- `./scripts/run-rook.sh sim` — start the server if needed, rebuild, and launch the iPhone app in Simulator
- `./scripts/run-rook.sh phone` — start the server if needed, rebuild, and launch the iPhone app on a paired device using your Mac's Tailscale MagicDNS hostname
- `./scripts/run-rook.sh stop` — stop the server, mac app, simulator app, booted simulators, and phone app when reachable

## Manual environment/debugging actions
- Register an environment: `POST /api/environments/register`
- Mark an environment unavailable: `POST /api/environments/unregister`
- Record an environment decision: `POST /api/environments/decision`
- Clear remembered environment decisions: remove `.var/rook/environment-decisions.sqlite`

## Monorepo notes
- `server/` currently owns the backend npm deps and lockfile
- `server/src/shared/` now holds the TypeScript protocol/domain contracts used by the server and the debug bridge CLI
- `clients/mac/` is a Swift/xcodegen package (not npm); the preferred local launcher is `./scripts/run-rook.sh mac`, though you can still build manually with `xcodegen generate` + `xcodebuild` — see its [README](clients/mac/README.md) for exact run steps and menu-bar troubleshooting
- `clients/iphone/` is a Swift/xcodegen package (not npm); the preferred local launchers are `./scripts/run-rook.sh sim` and `./scripts/run-rook.sh phone` (which now uses Tailscale MagicDNS for physical devices). It depends on `clients/RookKit/` and adds a Widget extension for the Live Activity — see its [README](clients/iphone/README.md) for device/simulator run steps and location-testing
- `clients/RookKit/` is a local Swift Package (iOS + macOS) holding the cross-platform layer shared by both Swift clients (models, REST/ACP clients, design system, voice, Live Activity attributes); build-check it with `cd clients/RookKit && swift build`
- `environment-repository/` holds local environment-linked skill bundles, keyed `<kind>/<path>` (`web/example.com`, `app/<slug>` for Mac apps fronted by the menu bar provider, and `place/<slug>` for physical locations fronted by the iPhone provider)
- `scripts/` holds repo-level utilities
- `PRODUCT/` holds product notes and evolving architecture docs
