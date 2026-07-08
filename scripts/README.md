# Scripts

All scripts run from the repo root and follow a consistent pattern: self-contained `.sh` files with supporting libraries tucked into `lib/<script-name>/`.

## Script index

### `run-rook.sh` — build and launch the server + clients

The primary development entry point. Starts the server (if needed) and builds + launches native clients.

```bash
./scripts/run-rook.sh server              # start the server
./scripts/run-rook.sh mac                 # build and launch the macOS menu-bar app
./scripts/run-rook.sh sim                 # build and launch in iPhone simulator
./scripts/run-rook.sh phone               # build and deploy to a physical iPhone
./scripts/run-rook.sh mac sim             # run multiple targets
./scripts/run-rook.sh stop                # stop everything (server, apps, simulators)
```

Flags: `--simulator NAME_OR_UDID`, `--device NAME_OR_UDID`, `--team TEAM_ID`, `--reset-permissions`

### `run-tests.sh` — run all test suites

Runs server tests (vitest), RookKit Swift package tests, iPhone XCTest suite, and macOS build validation in sequence.

```bash
./scripts/run-tests.sh
```

## Development tools

### MockAgent — replay transcripts without a real AI backend

MockAgent (`server/src/server/agents/MockAgent.ts`) is a subprocess-free agent that replays a pre-recorded transcript instead of calling a live AI. Useful for testing the UI, error surfacing, tool rendering, streaming behavior, and session lifecycle without burning API credits or needing network access.

**How it works:**
- Reads `.var/example_transcript.json` — a JSON array of "turns", each containing thinking, agent messages, tool calls, and tool results
- On each user message, ignores the input and replays the next turn token-by-token (split on whitespace, ~20ms per token, 500ms between messages)
- Emits proper ACP session updates so the UI renders identically to a real agent
- No subprocess, no ACP handshake — entirely self-contained

**Transcript format** (see `.agents/skills/create-a-mock-transcript/SKILL.md` for details):
```json
[
  {
    "timestamp": "2026-07-05T12:00:00Z",
    "events": [
      { "type": "thinking",      "text": "Let me think..." },
      { "type": "agent_message", "text": "Here's the result." },
      { "type": "tool_call",     "id": "call_1", "name": "read", "input": { "path": "foo.txt" } },
      { "type": "tool_result",   "id": "call_1", "output": "contents here" },
      { "type": "agent_message", "text": "The file says hello." }
    ]
  }
]
```

**Getting started:**
1. Ask the agent (using the `create-a-mock-transcript` skill) to create `.var/example_transcript.json`, or hand-craft one
2. Start the server + Mac client: `./scripts/run-rook.sh server mac`
3. Select MockAgent from the agent list and start a session
4. Send any message — the first turn replays. Send again for turn 2, etc.

MockAgent is fully modular: delete `MockAgent.ts` and its single registration line in `agentDiscovery.ts` to remove it. Nothing else depends on it.

### `interact-with-remote-agent.sh` — CLI agent session

Exercise the remote-agent bridge from the terminal. Starts a local server, opens a WebSocket, runs a prompt through any registered agent, and prints the resulting ACP client events as JSONL on stdout.

```bash
./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"
./scripts/interact-with-remote-agent.sh --list-agents
./scripts/interact-with-remote-agent.sh --raw-acp --agent MyPiOpenAiAgent "Run sleep 5"
```

Supports: `--steer`, `--steer-after-ms`, `--cancel-after-ms`, `--permission allow-once|allow-always|reject-once|cancel`, `--mode`, `--session`, `--restart`, `--replay`, `--raw-acp`, and event-type filtering (`--omit`, `--only`, `--omit-deltas`).

Supporting library: `lib/interact-with-remote-agent/`

### `print-environments.sh` — dump environment diagnostics

Hits `GET /api/diagnostics/environments` on the running server and pretty-prints active/recent environment state with counts.

```bash
./scripts/print-environments.sh
./scripts/print-environments.sh --url http://127.0.0.1:7665 --token "$ROOK_AUTH_TOKEN" --raw
```

### `dump-environment-decisions.sh` — dump the environment-decisions SQLite database

Reads `.var/rook/environment-decisions.sqlite` and prints the `environment_decisions` table to the terminal.

```bash
./scripts/dump-environment-decisions.sh
```

Supporting library: `lib/dump-environment-decisions/`

### `screenshot-with-voice.sh` — voice-annotated screenshot

Runs any command, voiced by `say`. Used during screen recordings to signal when a screenshot is being taken.

```bash
./scripts/screenshot-with-voice.sh screencapture -C ~/Desktop/screenshot.png
```

## Library structure

```
lib/
├── dump-environment-decisions/         # TypeScript tool to read the decisions DB
│   └── dump-environment-decisions.ts
└── interact-with-remote-agent/         # Remote agent CLI + shared ACP types/helpers
    ├── interact-with-remote-agent.ts   # Main CLI entry point
    ├── remoteAgent.ts                  # WebSocket-based remote agent client
    ├── acpClientTypes.ts               # ACP client event type definitions
    ├── acp.ts                          # Re-exports from server/src/shared/acp
    ├── agent.ts                        # Re-exports from server/src/shared/agent
    └── environment.ts                  # Re-exports from server/src/shared/environment
```

Each `lib/<script-name>/` subdirectory is self-contained: it contains only the TypeScript modules and type definitions that the corresponding shell script needs. No library code is shared across scripts.
