# Rook server

Fastify API and runtime orchestration for the Rook native clients and debug tooling. Part of the [Rook](../README.md) monorepo. Product/architecture notes: [PRODUCT/](../PRODUCT/). Repo-level setup, `.env`, binding, and auth live in [docs/setup.md](../docs/setup.md).

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

That starts the backend on `http://127.0.0.1:3000`.

If you launch through `./scripts/run-rook.sh server` (or `mac`/`sim`/`ios`/`android`) on
macOS, the script now starts the server in Terminal.app by default instead of a
plain detached `nohup` process. This preserves Terminal's protected-folder
access (notably Downloads/Desktop/Documents), which matters because Pi tool
subprocesses may otherwise lose TCC-granted file access.

## Network binding and auth

The server now always binds loopback (`127.0.0.1`). For remote phone access, set `ROOK_BIND_IP` to add a second listener on your Mac's VPN/private-network address, and set `ROOK_AUTH_TOKEN`. When a token is configured, every HTTP + WebSocket client — including localhost clients — must send it. See [docs/setup.md](../docs/setup.md).

## Pi agent configuration

Rook loads ACP-backed agent profiles from:
- `~/.rook/config/agent-profiles.json`

More detail: [`../docs/configuration.md`](../docs/configuration.md)

Default example:

```json
{
  "id": "MyPiOpenAiAgent",
  "type": "pi",
  "parentId": "PiAgent",
  "args": ["-e", "../my-agent", "--provider", "openai-codex", "--model", "gpt-5.4"]
}
```

Field meanings:
- `id`: label shown in the UI
- `type`: runtime type; use `pi` for the built-in Pi ACP launcher, `claude` for the built-in Claude ACP launcher, `acp` for a generic ACP subprocess
- `parentId`: inherit the built-in agent defaults/grouping
- `args`: runtime-specific arguments (`pi` forwards Pi-style args; `claude` currently supports `--add-dir <path>`)

Important defaults:
- `server/node_modules/pi-acp/dist/index.js` is the ACP adapter used for Pi
  - installed from `github:arcturus-labs/pi-acp`; `npm install` fetches it automatically
- `server/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` is the ACP adapter used for Claude
- `PiAgent` generates a tiny launcher internally at runtime instead of relying on a checked-in wrapper script
- `args: ["-e", "../my-agent", "--provider", "openai-codex", "--model", "gpt-5.4"]` points Pi at `../my-agent` on ChatGPT Codex subscription auth (`pi` then `/login`). Use provider `openai` with `--model openai/...` for direct API keys instead.

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

Rook also injects one repo-local Pi skill into every Pi session automatically:
- `../rook/skills/create-skills` — Anthropic's skill-authoring helper copied into this repo for environment-specific skill creation work

Rook currently also injects one repo-local Pi development/debug extension into every Pi session automatically:
- `../rook/dev-tools/prompt-trace-logger.ts` — logs provider payloads to `../rook/.var/pi-traces.jsonl` via `ROOK_PI_TRACE_LOG_PATH`

This is intentionally always-on for now so we can inspect prompt construction while building the environment-aware prompt path. It should later be gated behind an explicit dev/prod mode distinction.

When a session enters an environment, Rook also creates the user-local binding bundle skeleton for that environment under:
- `~/.rook/environment-repository/<kind>/<path>/.bundles/default/skills/`

Pi restarts for entered environments append startup instructions that point at those per-environment skill roots and list the currently entered environments plus their metadata. Entering a hierarchical environment (for example `app:md.obsidian/Rooknanigans`) also enters its active parent environments (for example `app:md.obsidian`) so broader app-level skills and instructions stay in scope.

Use this repo for the launcher-side configuration, mainly through:
- `~/.rook/config/agent-profiles.json` to choose which Pi package to launch and with which args

If your Pi package lives somewhere else, update the `args` path in `~/.rook/config/agent-profiles.json`.

Generated Pi launch helpers are written under `.var/rook/generated/pi-launchers/`.

Terse map of `src/`:

## Legacy `src/client` (old web UI)
- **App shell & entry**: `main.tsx`, `App.tsx`
- **Transport layer**: `remoteAgent.ts`, `agent.ts`
  - `RemoteAgent` uses **HTTP for session control** and **WebSocket for in-session events**.
  - `POST /api/agent/start` creates/reuses/restarts a session runtime.
  - `GET /api/ws?sessionId=...` subscribes to live session events; restored transcript history comes from ACP `session/load` after the websocket is attached.
  - The websocket boundary carries **ACP JSON-RPC directly** end-to-end.
  - The browser client handles ACP-native conversation state including tool calls, permission requests, plans, usage updates, mode/config controls, and stop reasons.
  - Session runtimes are automatically stopped after the last websocket client leaves and the room stays idle past a short grace period.
- **Screens (`src/client/screens`)**:
  - `AgentSelectionScreen.tsx`: choose an agent; start new session or continue.
  - `SessionSelectionScreen.tsx`: list prior sessions for an agent and join one.
  - `ChatScreen.tsx`: active chat view; renders `ChatPanel` for the current session.
  - App startup reopens the most recent saved session record and lands directly in chat when one exists.
- **UI components (`src/client/components`)**:
  - `ChatPanel.tsx`: main chat controller (state machine for replayed/live events, auto-queueing, queued-message edit/send-now/delete controls, stop/status line, modal selection).
  - `MessageThread.tsx`: renders block timeline and auto-scroll behavior during streaming.
  - `ComposeBox.tsx`: message input + send/stop button (Enter sends; if the agent is already working, the message is queued automatically; Shift+Enter inserts a newline).
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
  - `skillFiles.ts`: tree/file helpers for environment offer file previews (to be updated for bundle-oriented review).
- **Styling**: `styles/*`
- **Client tests**: `*.test.ts(x)` files in `src/client`

The older browser client sources in `src/client/` are now historical reference only.

## `src/server` (Fastify backend)

### Layering we are moving toward
- **API layer**: Fastify route modules in `src/server/routes/*` with bootstrap wiring in `index.ts`.
  - Parse requests, validate input, call services/repositories, shape responses.
- **Domain / service layer**: long-lived coordinators with in-memory runtime state.
  - `SessionRoomManager.ts`, `SessionRoom.ts`, `EnvironmentManager.ts`
- **Repository layer**: disk/SQLite-backed persistence behind small interfaces.
  - `EnvironmentRepository.ts`, `DirectoryEnvironmentRepository.ts`, `CompositeEnvironmentRepository.ts`, `EnvironmentDecisionStore.ts`, `sessionLog.ts`

The goal is not perfect purity yet; this is the direction to follow when adding new server code.

### API surface (`src/server/routes/*`)
- `GET /api/health`: service health.
- `GET /api/agents`: available agent definitions.
- `GET /api/agent/sessions?agent=<id>`: list saved sessions for an agent.
- `GET /api/agent/session/recent`: fetch the most recent saved session record across agents.
- `POST /api/agent/start`: start, reuse, or restart a session runtime.
- `POST /api/environments/register { id, metadata?, canonicalSourceUrl?, sourceName? }`: mark an environment available. If `id` is hierarchical (for example `app:md.obsidian/Peeps` or `web:en.wikipedia.org/wiki/Main_Page`), the server also treats all parent prefixes as available. Server bootstrap wires in a small JSONL capture sink that ensures `IGNORED/environment_metadata_captures/` exists and appends each explicit registration there for later inspection.
- `POST /api/environments/decision { environmentId, bundleHash, decision }`: record `accept | approve | ignore | reject` for an offered bundle.
- `GET /api/environments/preview?environmentId=...`: return full bundle/file preview data for inspection tooling and future richer review UI.
- `GET /api/diagnostics/environments`: return active/recent environment diagnostics including discovered bundles.
- `GET /api/ws?sessionId=...`: WebSocket endpoint for live session events.

### Main domain/service objects
- **Realtime session layer (`src/server/realtime`)**:
  - `SessionRoom.ts`: high-level room coordinator for runtime lifecycle, chat runs, subscriptions, and environment-driven rebuilds.
  - `RoomEventStream.ts`: in-memory sequencing and live subscriber fan-out.
  - `EnvironmentSessionState.ts`: unresolved environment offers + active environment skill-set state.
  - `SessionRoomManager.ts`: owns active `SessionRoom`s, keyed by `sessionId`, and swaps runtimes in place on restart.
  - `EnvironmentEventStub.ts`, `types.ts`: room/runtime plumbing.
- **Environment layer (`src/server/environment`)**:
  - `EnvironmentManager.ts`: global coordinator for environment availability and the 2×2 decision model; discovers bundles on registration and pushes bundle offer/resolve events into subscribed rooms.
  - `environmentMetadataCapture.ts`: small pluggable registration-capture sink module; the default server wiring uses a JSONL sink under `IGNORED/environment_metadata_captures/`.
  - `EnvironmentRepositoryService.ts`: thin service wrapper around repository lookups; returns bundle-organized environment content and computes exact-content bundle hashes for decisions.
  - `types.ts`: `EnvironmentRecord`, `EnvironmentEventListener`, decision/helper types.
- **Agent runtime layer (`src/server/agents`)**:
  - `BaseAgent.ts`: the generic ACP stdio subprocess runtime and lifecycle implementation.
  - `PiAgent.ts`: thin Pi-specific adapter that launches `pi-acp` with Pi-oriented defaults and arguments.
  - `agentDiscovery.ts`: registry/factory for known agents + parent/child metadata.
  - `config/agentProfiles.ts`: loads configured agent profiles from `~/.rook/config/agent-profiles.json`.
  - `sessionLog.ts`: JSONL persistence for session records used to resume provider sessions.

### Main repository/persistence objects
- `EnvironmentRepository.ts`: base repository abstraction for environment bundle lookup.
- `DirectoryEnvironmentRepository.ts`: reads `<kind>:<path>` environments from disk and returns canonical bundle objects from `.bundles/<bundle-id>/` directories.
- `CompositeEnvironmentRepository.ts`: unions multiple backing repositories into one logical repository.
- `EnvironmentDecisionStore.ts`: SQLite-backed store for persistent `approve` / `reject` decisions, keyed by the exact bundle-content hash.
  - Current DB location: `.var/rook/environment-decisions.sqlite`
  - Clear it by removing that file
- `sessionLog.ts`: stores provider/session restart metadata used to recreate stopped rooms.

### Other server pieces
- **Bootstrap/wiring**:
  - `index.ts`: constructs the server and registers route groups
  - `roomRuntime.ts`: room creation/reuse and environment runtime attachment
  - `serverHelpers.ts`: shared route parsing/validation helpers
- **Extensions/tools bridge**: `extensions/parentMessageTool.ts`
- **Server tests**: `index.test.ts`, `agents/*.test.ts`, `environment/*.test.ts`, `realtime/*.test.ts`

## `src/shared` (server-local shared contracts)
- **Shared agent/session payload types**: `shared/agent.ts`
  - session metadata, run status, message/tool payload shapes
- **Realtime/session event contract**: `shared/realtime.ts`
  - `SessionEvent` is the current internal UI/runtime update vocabulary
  - this remains transitional while the browser client is still reduced from ACP into the legacy view-model
- **Environment contracts**: `shared/environment.ts`, `shared/environmentRepository.ts`
  - environment decision types, bundle/repository types, websocket event kind names, and preview payload shapes shared by client/server

## Session / room mental model

The durable store that still matters for sessions is:
- **Session records** (`sessionLog.ts`) — provider-level resume metadata (agent id, restart args, skill paths). Used to recreate a live runtime after it has been stopped.

Transcript history is no longer Rookery-owned durable replay state; restored history comes from the agent through ACP `session/load`.

The **`SessionRoom`** is the live coordinator for one session. It holds the current `BaseAgent` runtime, serialises event publication, and fans events out to WebSocket subscribers. Rooms are managed by **`SessionRoomManager`** (keyed by `sessionId`).

The **`EnvironmentManager`** sits alongside the room manager. When a room is created it subscribes to the `EnvironmentManager`. External providers (for example the Chrome extension or macOS app) signal availability directly via `POST /api/environments/register`. The manager tracks global availability plus persistent/ephemeral decisions, asks `EnvironmentRepositoryService` for environment bundle content, and can call an injected registration-capture sink. In the default server wiring that sink appends explicit registration metadata captures to `IGNORED/environment_metadata_captures/`. `SessionRoom` is what turns the resulting environment events into client-visible state and runtime rebuilds.

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
- `BaseAgent.sendSteeringMessage(userMessage)`: inject a send-now message into the current workflow; the current ACP-backed implementation applies it at the next safe point inside the same workflow before the normal queued-turn drain continues.
- `BaseAgent.stop()`: release provider resources and fail any active run.
- `BaseAgent.record`: current `AgentSessionRecord` (set after `ensureStarted`).

## `src/test`
- **Global test setup**: `test/setup.ts`

## Debugging the bridge

From the repo root:

```bash
./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"
./scripts/interact-with-remote-agent.sh --raw-acp --agent PiAgent "hello"
./scripts/print-environments.sh
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
npm run dev --prefix server   # or: npm run dev (from repo root)
```
