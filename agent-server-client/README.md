# Agent Station (agent-server-client)

Web UI, Fastify API, and ACP-backed Pi adapter/runtime. Part of the [Agent Station](../README.md) monorepo. Product/architecture notes: [PRODUCT/](../PRODUCT/).

## Quick start

Before starting this package:
- install **pi.dev / Pi** and make sure the `pi` CLI is on your `PATH`
- make sure the sibling Pi agent package exists at `../my-agent/`

From this package:

```bash
npm install
npm run dev
```

Or from the repo root:

```bash
npm run dev
```

That starts the main app/server on `http://127.0.0.1:3000`.

## Pi agent configuration

Agent Station loads ACP-backed agent profiles from:
- `config/agent-profiles.json`

Default example:

```json
{
  "id": "MyPiAgent",
  "type": "pi",
  "parentId": "PiAgent",
  "args": ["-e", "../my-agent"]
}
```

Field meanings:
- `id`: label shown in the UI
- `type`: runtime type; use `pi` for the built-in Pi ACP launcher, `claude` for the built-in Claude ACP launcher, `acp` for a generic ACP subprocess
- `parentId`: inherit the built-in agent defaults/grouping
- `args`: runtime-specific arguments (`pi` forwards Pi-style args; `claude` currently supports `--add-dir <path>`)

Important defaults:
- `agent-server-client/node_modules/pi-acp/dist/index.js` is the ACP adapter used for Pi
- `agent-server-client/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` is the ACP adapter used for Claude
- `PiAgent` generates a tiny launcher internally at runtime instead of relying on a checked-in wrapper script
- `args: ["-e", "../my-agent"]` still points Pi at `../my-agent`

Example Claude profile:

```json
{
  "id": "MyClaudeAgent",
  "type": "claude",
  "parentId": "ClaudeAgent",
  "command": "claude",
  "args": ["--add-dir", "../my-org-repo"]
}
```

## About `../my-agent/`

`../my-agent/` is an external sibling package, not part of this repo. It is where the default Pi profile expects your Pi agent workspace to live.

Use that package for the agent-side configuration itself, such as:
- instructions/prompts
- installed or custom skills
- Pi package metadata/config

Use this repo for the launcher-side configuration, mainly:
- `config/agent-profiles.json` to choose which Pi package to launch and with which args

If your Pi package lives somewhere else, update the `args` path in `config/agent-profiles.json`.

Generated Pi launch helpers are written under `.var/agent-station/generated/pi-launchers/`.

Terse map of `src/`:

## `src/client` (web UI)
- **App shell & entry**: `main.tsx`, `App.tsx`
- **Transport layer**: `remoteAgent.ts`, `agent.ts`
  - `RemoteAgent` uses **HTTP for session control** and **WebSocket for in-session events**.
  - `POST /api/agent/start` creates/reuses/restarts a session runtime.
  - `GET /api/ws?sessionId=...` subscribes to live session events; restored transcript history comes from ACP `session/load` after the websocket is attached.
  - The websocket boundary now carries **ACP-shaped JSON-RPC messages**; the current browser client still reduces them into the existing `SessionEvent`/UI view-model as a migration step.
  - Session runtimes are automatically stopped after the last websocket client leaves and the room stays idle past a short grace period.
- **Screens (`src/client/screens`)**:
  - `AgentSelectionScreen.tsx`: choose an agent; start new session or continue.
  - `SessionSelectionScreen.tsx`: list prior sessions for an agent and join one.
  - `ChatScreen.tsx`: active chat view; renders `ChatPanel` for the current session.
  - App startup reopens the most recent saved session record and lands directly in chat when one exists.
- **UI components (`src/client/components`)**:
  - `ChatPanel.tsx`: main chat controller (state machine for replayed/live events, queueing, status line, modal selection).
  - `MessageThread.tsx`: renders block timeline and auto-scroll behavior during streaming.
  - `ComposeBox.tsx`: message input + send/queue button (Enter to send, Shift+Enter newline).
  - `BlockModal.tsx`: expanded view for a selected message/tool/error block.
  - `UserMessageBlock.tsx`: renders user text message blocks (markdown).
  - `AgentTextBlock.tsx`: renders assistant text message blocks (markdown + streaming cursor).
  - `ThinkingBlock.tsx`: renders assistant thinking blocks (markdown + streaming cursor).
  - `ToolBlock.tsx`: renders tool call lifecycle (args, status, result, expandable details).
  - `ErrorBlock.tsx`: renders protocol/connection/run error blocks.
  - `EnvironmentApprovalModal.tsx`: approval modal for environments with skill list, file tree, and content preview.
  - `SkillFilesPanel.tsx`: shared file tree + preview panel used by the environment modal.
- **Interaction helpers**:
  - `useBlockClick.ts`: opens a message/tool block detail view unless the user is selecting text.
  - `parentMessageTool.ts`: tracks `message_parent` tool calls and relays parsed payloads to `window.parent` via `postMessage`.
  - `skillFiles.ts`: tree/file helpers for environment skill previews.
- **Styling**: `styles/*`
- **Client tests**: `*.test.ts(x)` files in `src/client`

## `src/server` (Fastify backend)

### Layering we are moving toward
- **API layer**: Fastify route modules in `src/server/routes/*` with bootstrap wiring in `index.ts`.
  - Parse requests, validate input, call services/repositories, shape responses.
- **Domain / service layer**: long-lived coordinators with in-memory runtime state.
  - `SessionRoomManager.ts`, `SessionRoom.ts`, `EnvironmentManager.ts`
- **Repository layer**: disk/SQLite-backed persistence behind small interfaces.
  - `LocalEnvironmentRepository.ts`, `EnvironmentDecisionStore.ts`, `sessionLog.ts`

The goal is not perfect purity yet; this is the direction to follow when adding new server code.

### API surface (`src/server/routes/*`)
- `GET /api/health`: service health.
- `GET /api/agents`: available agent definitions.
- `GET /api/agent/sessions?agent=<id>`: list saved sessions for an agent.
- `GET /api/agent/session/recent`: fetch the most recent saved session record across agents.
- `POST /api/agent/start`: start, reuse, or restart a session runtime.
- `POST /api/environments/register { id, metadata?, canonicalSourceUrl?, sourceName? }`: mark an environment available.
- `POST /api/environments/unavailable { id }`: mark an environment unavailable.
- `POST /api/environments/decision { environmentId, decision }`: record `accept | approve | ignore | reject`.
- `GET /api/environments/preview?environmentId=...`: return skill/file preview data for the approval UI.
- `GET /api/ws?sessionId=...`: WebSocket endpoint for live session events.

### Main domain/service objects
- **Realtime session layer (`src/server/realtime`)**:
  - `SessionRoom.ts`: high-level room coordinator for runtime lifecycle, chat runs, subscriptions, and environment-driven rebuilds.
  - `RoomEventStream.ts`: in-memory sequencing and live subscriber fan-out.
  - `EnvironmentSessionState.ts`: unresolved environment offers + active environment skill-set state.
  - `SessionRoomManager.ts`: owns active `SessionRoom`s, keyed by `sessionId`, and swaps runtimes in place on restart.
  - `EnvironmentEventStub.ts`, `types.ts`: room/runtime plumbing.
- **Environment layer (`src/server/environment`)**:
  - `EnvironmentManager.ts`: global coordinator for environment availability and the 2×2 decision model; pushes offer/enter/exit/resolution events into subscribed rooms.
  - `types.ts`: `EnvironmentRecord`, `EnvironmentEventListener`, decision/helper types.
- **Agent runtime layer (`src/server/agents`)**:
  - `BaseAgent.ts`: the generic ACP stdio subprocess runtime and lifecycle implementation.
  - `PiAgent.ts`: thin Pi-specific adapter that launches `pi-acp` with Pi-oriented defaults and arguments.
  - `agentDiscovery.ts`: registry/factory for known agents + parent/child metadata.
  - `config/agentProfiles.ts`: loads configured agent profiles from `config/agent-profiles.json`.
  - `sessionLog.ts`: JSONL persistence for session records used to resume provider sessions.

### Main repository/persistence objects
- `LocalEnvironmentRepository.ts`: maps `<kind>:<path>` environment IDs to skill bundle directories under `environment-repository/` and reads previewable skill files.
- `EnvironmentDecisionStore.ts`: SQLite-backed store for persistent `approve` / `reject` decisions.
  - Current DB location: `.var/agent-station/environment-decisions.sqlite`
  - Drop it with `../scripts/drop-database.sh --yes`
- `sessionLog.ts`: stores provider/session restart metadata used to recreate stopped rooms.

### Other server pieces
- **Bootstrap/wiring**:
  - `index.ts`: constructs the server and registers route groups
  - `clientApp.ts`: prod static serving + Vite dev middleware
  - `roomRuntime.ts`: room creation/reuse and environment runtime attachment
  - `serverHelpers.ts`: shared route parsing/validation helpers
- **Extensions/tools bridge**: `extensions/parentMessageTool.ts`
- **Server tests**: `index.test.ts`, `agents/*.test.ts`, `environment/*.test.ts`, `realtime/*.test.ts`

## `src/shared` (cross-client/server contracts)
- **Shared agent/session payload types**: `shared/agent.ts`
  - session metadata, run status, message/tool payload shapes
- **Realtime/session event contract**: `shared/realtime.ts`
  - `SessionEvent` is the current internal UI/runtime update vocabulary
  - this remains transitional while the browser client is still reduced from ACP into the legacy view-model
- **Environment contracts**: `shared/environment.ts`, `shared/environmentSkillPreview.ts`
  - environment decision types, websocket event kind names, and preview payload shapes shared by client/server

## Session / room mental model

The durable store that still matters for sessions is:
- **Session records** (`sessionLog.ts`) — provider-level resume metadata (agent id, restart args, skill paths). Used to recreate a live runtime after it has been stopped.

Transcript history is no longer Rookery-owned durable replay state; restored history comes from the agent through ACP `session/load`.

The **`SessionRoom`** is the live coordinator for one session. It holds the current `BaseAgent` runtime, serialises event publication, and fans events out to WebSocket subscribers. Rooms are managed by **`SessionRoomManager`** (keyed by `sessionId`).

The **`EnvironmentManager`** sits alongside the room manager. When a room is created it subscribes to the `EnvironmentManager`. External providers (for example the Chrome extension) signal availability directly via `POST /api/environments/register` / `POST /api/environments/unavailable`. The manager tracks global availability plus persistent/ephemeral decisions, then pushes offer / enter / exit / resolution events into subscribed rooms. `SessionRoom` is what turns those into client-visible state and runtime rebuilds.

**`POST /api/agent/start`** is the only way to create or modify a room (`createOrReuseRoom` in `index.ts`):

| call | result |
|------|--------|
| no prior session | new `BaseAgent` + new room |
| prior session, room live | return existing room unchanged |
| prior session, room live, `restartExisting: true` | stop old agent, new agent, **same room** (session id preserved) |
| prior session, room gone (was idle-stopped) | new agent from saved restart metadata + new room |

**Event flow (runtime → clients):**
`BaseAgent.emitSessionEvent` → room's event sink (set via `attachRuntimeEventSink`) → in-memory sequencing + fan-out to WebSocket subscribers.

**Joining a live room** (`GET /api/ws`): subscribe first, then let restored sessions stream history from ACP `session/load` if the agent/runtime supports it.

**Idle shutdown:** when the last subscriber disconnects, the room starts a grace-period timer (default 15 s). If no client rejoins, `agent.stop()` is called and the room is removed from the manager.

## Server agent class API
- `BaseAgent.setEventSink((event) => ...)`: wired by the room to route agent events into the session log and subscribers.
- `BaseAgent.ensureStarted()`: start a new provider session or resume from restart metadata.
- `BaseAgent.run(userMessage)`: run one prompt turn (queued serially by the room).
- `BaseAgent.stop()`: release provider resources and fail any active run.
- `BaseAgent.record`: current `AgentSessionRecord` (set after `ensureStarted`).

## `src/test`
- **Global test setup**: `test/setup.ts`

## Debugging the bridge

From the repo root:

```bash
./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"
./scripts/interact-with-remote-agent.sh --raw-acp --agent PiAgent "hello"
```

- default mode prints the translated `SessionEvent` stream the current UI consumes
- `--raw-acp` prints the raw ACP JSON-RPC messages on the boundary

## Commands

From repo root:

```bash
npm run dev
npm test
npm run build
```

From this package:

```bash
npm run dev -w agent-server-client
```
