# Rook - As-Built Architecture

**Last Updated**: 2026-07-14

This document is the short, current architecture description for the repo as it exists today. It intentionally avoids historical detail and low-level implementation notes.

## 1. System summary

Rook is a local-first monorepo centered on one service at `127.0.0.1:7665`:

- the server always binds loopback for on-machine clients
- it may also expose a second listener on a configured remote/VPN address for phone access
- when configured, bearer auth is required for all client access, including localhost

- a **Fastify server**
- a single connection-level **ACP WebSocket facade** (`/api/ws`)
- an **AgentRuntimeManager** that lazily manages per-session runtime subprocesses
- an **environment manager** that hot-loads environment-linked skills into sessions

## 2. Top-level shape

```text
Host clients / providers                         registers environment kind
  ├─ macOS menu bar app (native Swift)           mac:<slug>, web:<slug>
  ├─ iPhone app (native Swift)                   location:<slug>
  ├─ Android app (Kotlin/Compose)                (same REST + ACP contract)
  └─ rook CLI (Node.js)                          development/debugging client
            │
            ▼
server/ (Fastify)
  ├─ ACP WebSocket facade (/api/ws)
  ├─ Environment HTTP API (register, preview, decision, entry/exit)
  ├─ AgentRuntimeManager (lazy per-session runtime catalog)
  ├─ EnvironmentManager
  └─ SessionRuntime subprocesses
        ├─ Pi ACP bridge (pi-acp)
        ├─ Claude ACP bridge
        ├─ Cursor ACP bridge
        ├─ generic ACP
        └─ MockAcpAgent (testing)

clients/RookKit    ← shared Swift package (iOS + macOS)
clients/cli        ← minimal ACP-first debugging client
```

## 3. Core architectural idea

Rook has two important protocol boundaries:

1. **Client ↔ server:** ACP over WebSocket — one connection per client, session-agnostic
2. **Server ↔ agent runtime:** ACP over stdio subprocesses — one process per session

The server is a single ACP-compliant agent from the client's perspective. Internally it's a broker that lazily manages per-session runtime subprocesses.

The chat connection is 100% ACP-compliant — no `_rookery/steering_prompt`, no proprietary session updates.

See also: [`PRODUCT/agent-client-protocol.md`](./agent-client-protocol.md)

## 4. Main packages

| Package | Current role |
|---|---|
| `server/` | Main backend at `:7665`; ACP facade, runtime orchestration, environment manager |
| `clients/mac/` | Native macOS client and environment provider (`mac:<slug>`, `web:<slug>`) |
| `clients/iphone/` | Native iOS client and location environment provider (`location:<slug>`) |
| `clients/android/` | Native Android client |
| `clients/cli/` | Minimal ACP-first CLI for fast session/runtime debugging |
| `clients/RookKit/` | Shared Swift package (iOS + macOS) |
| `environment-repository/` | Local environment bundle content keyed by `<kind>/<path>` |
| `PRODUCT/` | Product and architecture notes |

## 5. Main server architecture

### 5.1 Fastify server

`server/src/server/index.ts` builds the main service.

It wires together:

- `AgentRuntimeManager` — service layer: runtime catalog, per-session lifecycle
- `EnvironmentManager` — environment availability, decisions, bundle discovery
- `EnvironmentDecisionStore` — SQLite-backed persistent decisions
- `SqliteSessionRepository` — session persistence and environment membership
- `RookDatastore` — shared SQLite connection
- `EnvironmentRepository` / `DirectoryEnvironmentRepository` / `CompositeEnvironmentRepository` — bundle content resolution
- REST routes: runtime enumeration, environment registration/decision/preview, session environments
- ACP WebSocket facade

Network exposure:
- loopback listener for localhost/macOS clients
- optional second listener on configured remote/VPN address for phone access
- bearer auth enforced for all HTTP + WebSocket when configured

### 5.2 AgentRuntimeManager

`AgentRuntimeManager` is the orchestration layer. It:

- loads the configured runtime catalog from `~/.rook/config/agent-runtimes.json`
- lazily creates one `SessionRuntime` per public session (not per configured runtime)
- maps stable Rook-generated UUID session IDs to runtime-local IDs
- presents a unified cross-runtime `session/list`
- subscribes per-session to `EnvironmentManager` for environment-driven restarts
- applies session-specific skill/extension paths on runtime launch

### 5.3 SessionRuntime

A `SessionRuntime` is one ACP subprocess lifecycle for one session:

- spawns the underlying ACP subprocess (Pi ACP bridge, Claude ACP bridge, etc.)
- creates, loads, and restarts ACP sessions
- forwards ACP requests and notifications
- serializes prompt and restart work

Provider differences are composed launch strategies in `runtimeLaunchPlan.ts`, not subclasses.

### 5.4 Runtime configuration

Runtimes are explicitly configured in `~/.rook/config/agent-runtimes.json`. There are no implicit parent/base definitions. Supported types: `pi`, `claude`, `cursor`, `acp`.

Configured profiles include `MockAcpAgent` (an `acp`-type test runtime at `test-fixtures/mockAcpServer.mjs`) for fast CLI-driven debugging.

### 5.5 Pi integration

- the server launches `pi-acp` as the ACP stdio bridge
- `pi-acp` in turn launches `pi`
- a generated launcher (`runtimeLaunchPlan.ts`) injects Pi args, skill paths, extension paths, and environment-specific appended system prompts
- generated launch helpers write to `.var/rook/generated/pi-launchers/`

## 6. Environment architecture

### 6.1 What an environment is

An **environment** is a context the user is currently "in", identified as `<kind>:<path>`.

Examples: `mac:<bundleId>`, `web:<host>/<path>`, `location:<slug>`, `location:<domain>/<state-zip-street>`.

An environment maps to a directory in `environment-repository/` and provides zero or more `.bundles/<bundle-id>/` directories.

### 6.2 Decision model

- `accept`: allow once
- `approve`: allow persistently
- `ignore`: dismiss once
- `reject`: reject persistently

Persistent decisions are SQLite-backed, keyed by bundle-content hash.

### 6.3 How environments affect sessions

1. Providers call `POST /api/environments/register`
2. `EnvironmentManager` resolves bundles, hashes content, offers to subscribed sessions
3. `AgentRuntimeManager` applies approved skill paths to session launch configuration
4. On environment change, only the affected session's runtime restarts
5. The replacement process must successfully `session/load` the existing ACP session before the old process retires

### 6.4 Environment offers (ACP extension)

Environment offers use a negotiated ACP extension under the owned namespace `com.rookkeeper`:

- `_com.rookkeeper/environment_offer` notification
- `_com.rookkeeper/environment_offer_resolve` request
- `_com.rookkeeper/environment_offer_resolved` notification

Support is advertised in `initialize` capability `_meta`.

### 6.5 Location identification

On arrival, the iPhone POSTs `/api/environments/register-location`. The server reverse-resolves coordinates to nearby businesses, normalizes to `location:<domain>/…` IDs, and registers them into the active/recent cache.

## 7. Client architecture

The two native Swift clients share one cross-platform layer (`clients/RookKit`) — models, ACP WebSocket client, design system, chat blocks, voice, and Live Activity.

The CLI client (`clients/cli/`) is a fast development/debugging tool that talks ACP directly.

### 7.1 macOS menu bar app

- unified Sessions home screen (session list + New Chat form)
- foreground-app environment provider (`mac:<bundleId>`, `web:<host>/<path>`)
- streaming ACP chat with text, thinking, tools, permissions, plans

### 7.2 iPhone app

- unified Sessions home screen
- location environment provider (`location:<slug>`) via CoreLocation geofencing
- Live Activity / Dynamic Island
- on-device voice (speech recognition + synthesis)

### 7.3 Android app

- same unified Sessions home model
- Compose chat blocks mapping standard ACP updates

### 7.4 CLI client

- `rook exec --runtime <id> <prompt>` — one-shot turn against any runtime
- `rook exec --sessionId <id> <prompt>` — resume and extend a session
- `rook sessions` — list sessions with metadata
- `rook --transcript --sessionId <id>` — dump raw ACP transcript
- `rook --runtime <id>` — interactive chat mode

## 8. Live message flow

### 8.1 Connecting

```text
client
  -> WebSocket connect to /api/ws
  -> initialize (returns runtime catalog, capabilities)
```

### 8.2 Running a prompt

```text
client ACP request: session/prompt
  -> acpFacadeRoute
  -> AgentRuntimeManager.requestForSession()
  -> SessionRuntime (stdio to ACP subprocess)
  -> session/update notifications
  -> AgentRuntimeManager subscribers
  -> connected client
```

### 8.3 Resuming a session

```text
client ACP request: session/load
  -> AgentRuntimeManager.restoreEnvironmentMembership()
  -> SessionRuntime.request("session/load", ...)
  -> runtime replays session history via session/update notifications
  -> client receives transcript
```

`session/cancel` uses standard ACP cancel. There is no `_rookery/steering_prompt`.

## 9. API surface

### 9.1 REST

- `GET /api/health`
- `GET /api/agent_runtimes` — configured runtime catalog
- `POST /api/session/environments` — enter/leave environments for a session
- `POST /api/environments/register`
- `POST /api/environments/decision`
- `GET /api/environments/preview`
- `POST /api/environments/register-location`
- `GET /api/diagnostics/environments`

### 9.2 WebSocket

- `GET /api/ws` — connection-level ACP endpoint (no session query parameter)

Supported ACP methods: `initialize`, `session/list`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option`, `session/close`.

Supported ACP extension: `_com.rookkeeper/environment_offer*` (negotiated via `initialize` capabilities).
