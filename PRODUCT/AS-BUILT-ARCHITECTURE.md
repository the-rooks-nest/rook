# Rookery - As-Built Architecture

**Last Updated**: 2026-06-16

This document is the short, current architecture description for the repo as it exists today. It intentionally avoids historical detail and low-level implementation notes.

## 1. System summary

Rookery is a local-first monorepo centered on one service at `127.0.0.1:3000`:

- the server always binds loopback for on-machine clients
- it may also expose a second listener on a configured remote/VPN address for phone access
- when configured, bearer auth is required for all client access, including localhost

- a **Fastify server**
- a **React Native web chat UI**
- a **WebSocket ACP bridge** to agent runtimes
- an **environment manager** that can hot-load environment-linked skills into a session

The repo is organized into focused top-level packages: `server/` and a `clients/` directory holding the remaining native app packages.

## 2. Top-level shape

```text
Host clients / providers                         registers environment kind
  ├─ Browser at :3000
  ├─ Chrome extension                            web:<slug>
  ├─ Obsidian plugin
  ├─ macOS menu bar app (native Swift)           app:<slug>, web:<slug>   (foreground encounters, plus close detection)
  └─ iPhone app (native Swift)                   loc:<slug> (GPS geofence)
            │
            ▼
server/ (Fastify)
  ├─ REST API for agent/session/environment control
  ├─ WebSocket endpoint carrying ACP JSON-RPC
  ├─ SessionRoomManager / SessionRoom runtime orchestration
  ├─ EnvironmentManager
  └─ ACP subprocess agents
        ├─ PiAgent
        ├─ ClaudeAgent
        ├─ CursorAgent
        └─ generic ACP agent

server/src/shared  ← server-local TypeScript contracts: ACP types, environment DTOs, agent/session DTOs
clients/RookKit    ← shared Swift package (iOS + macOS) backing the two native Swift clients
```

## 3. Core architectural idea

Rookery has two important protocol boundaries:

1. **Client ↔ server:** ACP over WebSocket
2. **Server ↔ agent runtime:** ACP over stdio subprocesses

That is the main simplifying idea in the current architecture.

The server is not trying to invent a new agent protocol. It is a coordinator that:

- creates and resumes sessions
- manages live room lifecycle
- forwards ACP updates between clients and runtimes
- adds Rookery-specific behavior around environments, approvals, and steering prompts

See also: [`PRODUCT/agent-client-protocol.md`](./agent-client-protocol.md)

## 4. Main packages

| Package | Current role |
|---|---|
| `server/` | Main backend at `:3000`; server, runtime orchestration, environment approvals |
| `server/src/shared/` | Server-local ACP types, environment DTOs, agent/session contracts |
| `clients/mac/` | Native macOS client and environment provider (`app:<slug>`) |
| `clients/iphone/` | Native iOS client and location environment provider (`loc:<slug>`) |
| `clients/RookKit/` | Shared Swift package (iOS + macOS) backing both native Swift clients |
| `environment-repository/` | Local environment bundle content keyed by `<kind>/<path>` |
| `PRODUCT/` | Product and architecture notes |

## 5. Main server architecture

### 5.1 Fastify server

`server/src/server/index.ts` builds the main service.

It wires together:

- `SessionRoomManager`
- `EnvironmentManager`
- `EnvironmentDecisionStore`
- `EnvironmentRepository`
- `DirectoryEnvironmentRepository`
- `CompositeEnvironmentRepository`
- `EnvironmentRepositoryService`
- REST routes
- WebSocket ACP route
- React app hosting

The server is now API/websocket-only; native clients and debug scripts connect to it directly.

Network exposure model as built:
- localhost/macOS clients talk to the loopback listener
- remote phone access is served by a second remote listener rather than broad `0.0.0.0` binding
- auth is enforced for all HTTP + WebSocket access when configured

### 5.2 Session rooms

A **SessionRoom** is the live coordinator for one agent session.

A room owns:

- the current `BaseAgent` runtime
- websocket subscribers
- room-local environment state
- serialized execution for prompts and runtime rebuilds
- idle shutdown behavior

`SessionRoomManager` keeps exactly one live room per session id.

When the last client disconnects, the room waits for a short idle timeout and then stops the runtime.

### 5.3 Agent runtime layer

`BaseAgent` is the common ACP subprocess runtime.

Responsibilities:

- spawn the subprocess
- create or load ACP sessions
- forward `session/update` notifications to the room
- forward permission requests to the client
- send prompts, cancel requests, mode changes, and config changes
- persist enough restart metadata to recreate a stopped session later

Concrete adapters:

- `PiAgent`
- `ClaudeAgent`
- `CursorAgent`
- generic ACP profiles loaded from config

### 5.4 Pi integration

Pi is no longer integrated through the older Pi-specific JSONL RPC path.

Current design:

- `PiAgent` is an ACP agent
- it launches `pi-acp`
- `pi-acp` in turn launches `pi`
- a small generated launcher injects Pi args, skill paths, extension paths, and any environment-specific appended system prompt text
- the default profile still points Pi at the sibling `../my-agent/` package
- every Pi session also gets the repo-local `skills/create-skills` skill at startup so the runtime always knows how to author new skills

Generated Pi launch helpers are written under:

- `.var/rook/generated/pi-launchers/`

### 5.5 Agent discovery

Agents come from two places:

- built-in parents: `PiAgent`, `ClaudeAgent`, `CursorAgent`
- configured profiles from `~/.rook/config/agent-profiles.json`

Profiles let the app expose multiple concrete agents while reusing the shared runtime architecture.

## 6. Environment architecture

### 6.1 What an environment is

An **environment** is a context the user is currently "in", identified as:

- `<kind>:<path>`

Examples:

- `web:<host>/<path>` (browser URL-derived site/page context)
- `web:example.com`
- `app:<bundleId>` (macOS menu bar app — encountered Mac app identity)
- `app:md.obsidian/<vault>` (macOS menu bar app — Obsidian vault context)
- `web:<host>/<path>` (macOS menu bar app — active browser URL, protocol/query stripped)
- `loc:<slug>` (iPhone app — current GPS geofence)
- `loc:<domain>/<state-zip-street>` (iPhone — a business identified from the user's coordinate; address-based key, store number is metadata only; see §6.6)

An environment maps to a directory in `environment-repository/` and provides zero or more `.bundles/<bundle-id>/` directories. The kind (`web`, `app`, `loc`, …) is just the part before the first colon; the directory-backed repository resolves `<kind>:<path>` to `environment-repository/<kind>/<path>/`, so a new provider kind needs no server change — only new bundle content on disk.

### 6.2 Environment repository

`DirectoryEnvironmentRepository` resolves an environment id to a local directory and reads:

- `.bundles/<bundle-id>/` directories
- grouped `skills/`, `mcp-servers/`, and `apps/` text artifacts
- bundle-organized content for runtime bridging and preview rendering

`CompositeEnvironmentRepository` unions the monorepo repository with the user-local `~/.rook/environment-repository/` root, and `EnvironmentRepositoryService` is the thin service wrapper that higher layers call.

Current storage model is simple: local disk only.

### 6.3 Environment manager

`EnvironmentManager` currently tracks:

| Concept | Meaning |
|---|---|
| **active** | recently registered and still within the active window |
| **recent** | seen recently, but now past the active window |
| **decision** | allow/reject choice for an exact bundle-content hash |

Decision model remains:

- `accept`: allow once
- `approve`: allow persistently
- `ignore`: dismiss once
- `reject`: reject persistently

Storage model:

- active/recent environment memory lives in process memory
- discovered bundles and their exact-content hashes live alongside each remembered environment in memory
- ephemeral decisions (`accept`, `ignore`) live in memory
- persistent decisions (`approve`, `reject`) live in SQLite keyed by bundle-content hash

### 6.4 How environments affect sessions

When an environment becomes available:

1. providers call `/api/environments/register`
2. the Mac provider does this immediately on foreground encounter, and also on wake/server-reconnect reconciliation for currently visible environments
3. `EnvironmentManager` stores the exact registration in memory with its latest touch time
4. on registration, it also consults the repository, resolves any valid bundles, hashes their text contents, and remembers the bundle ids plus `.bundles/` collection path(s) associated with that environment
5. any active, undecided bundles are offered to subscribed sessions for review
6. once a session enters an environment, `EnvironmentManager` creates the user-local binding bundle skeleton at `~/.rook/environment-repository/<kind>/<path>/.bundles/default/skills/`
7. entered sessions rebuild their runtimes with the approved environment skills, and Pi runtimes also get appended startup instructions that explain where those per-environment skill roots live and list the currently entered environments plus metadata
8. the environment is counted as **active** for a configurable active window (currently 5m15s)
9. when an environment is no longer refreshed, it naturally ages from **active** to **recent** and any pending bundle offers resolve as unavailable
10. inactive/recent entries remain in memory for a longer retention window (currently 30 minutes), then are forgotten

### 6.5 Environment-to-agent bridge

The product intent is still:

- the agent should not be deeply coupled to environment internals
- environments contribute **skills**
- interaction with the environment stays narrow and explicit

That remains consistent with:

- [`PRODUCT/relationship-or-environments-skills-and-agent.md`](./relationship-or-environments-skills-and-agent.md)
- [`PRODUCT/narrow-skills-environment-bridge.md`](./narrow-skills-environment-bridge.md)

### 6.6 Location identification (`loc:`)

Beyond providers that already know their environment id, the iPhone can turn a raw coordinate into available `loc:` environments. On a settled (non-driving) `CLVisit` arrival the phone POSTs `/api/environments/register-location`; `server/src/server/location/` reverse-resolves the coordinate to nearby businesses (the swappable `PoiLookupProvider`, today backed by ptiles fetched directly from the upstream host — an internal detail, no public route), normalizes them to stable address-based `loc:<domain>/…` ids, and `LocationRegistrar` writes the ranked set into the same in-memory active/recent cache as every other provider (§6.3–6.4). A read-only `/api/environments/identify` returns the same candidates without registering.

Two delivery channels carry a place to the agent: its **skills** load on-demand through the repository facade (the synthesized location-context bundle is served by a programmatic `LocationContextRepository`, no special-cased paths), and a concise **best-guess + nearby** context is *pushed* into the agent via the shared `AgentContext`/`setContextEntry` (§6.5) so it always knows where it is.

Full as-built detail — assumptions, limitations, and follow-ups — lives in [`PRODUCT/location-environment-awareness.md`](./location-environment-awareness.md).

## 7. Client architecture

### 7.1 Web client

The former browser app has been removed from the active architecture.

Main responsibilities are unchanged: agent selection, session lifecycle, ACP websocket communication, streaming conversation rendering, tool/permission/plan/usage/mode/config handling, queued messages, and environment approval UI.

The client is structured around:
- primary user-facing clients are now the native macOS and iPhone apps plus repo-level debug scripts
- platform-adaptive rendering seams (markdown, controls)
- the server remains the sole TypeScript runtime package

- `clients/RookKit/` remains the shared Swift layer for the two native clients

### 7.2 Other clients/providers

Current ecosystem around `:3000`:

- **Chrome extension**: detects supported web contexts and registers `web:<slug>` environments
- **Obsidian plugin**: embeds the app in a sidebar view
- **macOS menu bar app**: native SwiftUI client with the same backend; registers newly seen user-visible app/page encounters, re-registers them every 5 minutes while still in its local TTL cache, and otherwise lets the server age them out
- **iPhone app**: native SwiftUI client that registers `loc:<slug>` environments from GPS geofences, making the agent location-aware (skills load as you arrive at a defined place). It also drives ptiles-based business discovery on arrival, registering `loc:<domain>/…` environments — see [`location-environment-awareness.md`](./location-environment-awareness.md). Adds Live Activity / Dynamic Island presence and on-device voice.

The two native Swift clients share one cross-platform layer — models, the REST/ACP-WebSocket clients, the design system and chat-block views, voice, and Live Activity attributes — through the `clients/RookKit` Swift package, so they stay protocol- and design-consistent with a single source of truth.

## 8. Live message flow

### 8.1 Starting a session

```text
client
  -> POST /api/agent/start
  -> create or reuse SessionRoom
  -> room has runtime + session metadata
```

If a prior session record exists but no live room exists, the server recreates the runtime from saved restart metadata.

### 8.2 Running a prompt

```text
client websocket ACP request: session/prompt
  -> websocketRoute
  -> SessionRoom.run()
  -> BaseAgent.run()
  -> ACP subprocess
  -> session/update notifications
  -> SessionRoom subscribers
  -> connected clients
```

The room serializes prompt execution so overlapping turns do not race.

### 8.3 Restoring history

Transcript restoration is primarily agent-owned now.

On resumed sessions, `BaseAgent` uses ACP `session/load`, and restored history comes from the runtime rather than from a Rookery-owned replay log.

### 8.4 Cancel and send-now

- normal stop uses ACP `session/cancel`
- send-now uses a Rookery extension request: `_rookery/steering_prompt`

This preserves the product behavior while keeping provider-specific steering inside the runtime layer.

## 9. API surface

### 9.1 REST

Current major routes:

- `GET /api/health`
- `GET /api/agents`
- `GET /api/agent/sessions?agent=<id>`
- `GET /api/agent/session/recent`
- `POST /api/agent/start`
- `POST /api/environments/register`
- `POST /api/environments/decision` (bundle-level 2×2 decision keyed by exact bundle hash)
- `POST /api/environments/identify` (read-only: coordinate → candidate `loc:` environments)
- `POST /api/environments/register-location` (identify + register/auto-enter the dwell set)
- `GET /api/environments/preview`
- `GET /api/diagnostics/environments` (development-only grouped diagnostics: dumps active + recent environment memory)

### 9.2 WebSocket

- `GET /api/ws?sessionId=...`

The websocket carries ACP JSON-RPC messages.

Supported behaviors include:

- `session/prompt`
- `session/cancel`
- `session/set_mode`
- `session/set_config_option`
- `_rookery/steering_prompt`
- permission request/response relay
- `session/update` fan-out from the runtime

## 10. Persistence and local state

Current local mutable state is under `.var/rook/`.

Important pieces:

- `environment-decisions.sqlite` - persistent bundle approvals/rejections keyed by exact bundle hash
- generated Pi launchers
- session records in `sessionLog.ts` backing saved/restartable sessions

The important architecture change versus older versions is:

- Rookery is **not** the primary durable transcript store anymore
- live conversation history is restored via ACP `session/load`

## 11. Current shared contracts

TypeScript protocol/domain contracts now live directly under `server/src/shared/`.

Important files:

- `server/src/shared/acp.ts` — ACP JSON-RPC types
- `server/src/shared/agent.ts` — session metadata and agent-facing shared types
- `server/src/shared/environment.ts` — environment ids, decisions, and preview types

The debug bridge CLI and the server import from `server/src/shared/`. The server also retains locally-scoped shared helpers (`realtime.ts`) that carry server-side logic.

## 12. Architecture constraints that matter right now

1. **One live room per session id.**
2. **ACP is the primary protocol on both sides of the server.**
3. **Environment bundle decisions are keyed by exact bundle-content hash, and current environment availability is process-local memory.**
4. **`EnvironmentManager` currently discovers/hashes/offers bundles on registration rather than rebuilding runtimes.**
5. **Session restoration depends on saved restart metadata plus ACP `session/load`.**
6. **Pi-specific behavior should stay inside `PiAgent` or `pi-acp`, not leak into the client.**

## 13. Recommended mental model

The shortest accurate model of the current system is:

> Rookery is a localhost ACP router/orchestrator with native clients, a room-based session lifecycle, and an environment system that currently caches/logs active and recent environments in memory.
