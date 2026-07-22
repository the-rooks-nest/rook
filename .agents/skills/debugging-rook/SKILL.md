---
name: debugging-rook
description: Debugging patterns, CLI commands, scripts, and workflows for the Rook monorepo. Use when investigating bugs, testing server/client behavior, stepping through session replay, or inspecting environment state.
---

# Debugging Rook

Use these tools and patterns to investigate and fix bugs in Rook.

## Priority order

1. **rook CLI + mock agent** — fastest iteration, no native rebuilds
2. **rook CLI + real runtime** — when you need real AI behavior
3. **Codex + computer use on the mac client** — only when the bug is in native UI rendering

## rook CLI

All commands need `--auth-token "$ROOK_AUTH_TOKEN"` (source `.env` first).

### One-shot exec

```bash
rook exec --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN" "tell me a joke"
rook exec --sessionId <id> --auth-token "$ROOK_AUTH_TOKEN" "what did you just say?"
rook exec --last-message-only --runtime MockAcpAgent --auth-token "$ROOK_AUTH_TOKEN" "12+34"
```

### Session management

```bash
rook sessions --auth-token "$ROOK_AUTH_TOKEN"                 # list sessions
rook sessions --limit 5 --auth-token "$ROOK_AUTH_TOKEN"      # limit output
rook --transcript --sessionId <id> --auth-token "$ROOK_AUTH_TOKEN"  # dump replay
```

### Named sessions (for mac client testing)

```bash
rook exec --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN" --title "my-test" "ls"
```
`--title` only works with `--runtime` (new session), not `--sessionId`.

### Environment inspection

```bash
rook environments --auth-token "$ROOK_AUTH_TOKEN"             # list known environments
rook environments --limit 5 --auth-token "$ROOK_AUTH_TOKEN"   # with bundle counts
```

### Join/leave environments on session create or resume

```bash
rook exec --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN" --join location:office "hi"
rook exec --sessionId <id> --auth-token "$ROOK_AUTH_TOKEN" --leave web:example.com "done"
```
`--join` and `--leave` are repeatable. Works with both `--runtime` and `--sessionId`.

### Interactive mode

```bash
rook --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN"   # new session, chat
rook --sessionId <id> --auth-token "$ROOK_AUTH_TOKEN"            # resume, transcript replays
```
Ctrl+C prints sessionId and exits.

## Mock agent

File: `server/src/server/agents/test-fixtures/mockAcpServer.mjs`

- stores a transcript and replays on `session/load`
- streams thoughts, tool calls, tool outputs, assistant text
- handles common prompt patterns: jokes, ls, arithmetic, prime checking
- serialized via `enqueue` so load replay and prompt processing don't interleave
- edit it to add new test scenarios

## Debug scripts

### `scripts/run-rook.sh`
Launch the server and/or clients:
```bash
./scripts/run-rook.sh mac server     # mac client + server (most common)
./scripts/run-rook.sh server         # server only
./scripts/run-rook.sh stop           # kill everything
```

### `scripts/interact-with-remote-agent.sh`
Exercise the remote-agent bridge without any UI. Needs `server/` deps installed.

### `scripts/print-environments.sh`
Dump active/recent environment state from the server:
```bash
./scripts/print-environments.sh
./scripts/print-environments.sh --raw    # full JSON, no jq formatting
```
Uses `GET /api/diagnostics/environments`. Useful for inspecting what environments the server knows about, their status (active/recent), and bundles.

### Environment paths

Environment bundles live in two places:

- **Repo**: `environment-repository/<kind>/<path>/.bundles/<bundle-id>/` — checked-in bundles (skills, AGENTS.md, tools)
- **User-local**: `~/.rook/environment-repository/<kind>/<path>/.bundles/<bundle-id>/` — bundles Rook writes at runtime (e.g. agent-authored skills, memories)

For the full filesystem shape and authoring model, see:
- `PRODUCT/environment-repository.md`
- `PRODUCT/environment-local-authoring.md`

When debugging missing skills or instructions, check both locations. The user-local path is where `--join` will pick up agent-authored artifacts.

### `scripts/dump-environment-decisions.sh`
Dump the SQLite environment_decisions table:
```bash
./scripts/dump-environment-decisions.sh
```
Shows all approve/reject/accept/ignore decisions keyed by bundle hash.

### `scripts/tail-logs.sh`
Tail Pi provider-payload traces:
```bash
./scripts/tail-logs.sh
./scripts/tail-logs.sh --instructions    # pretty-print system instructions
./scripts/tail-logs.sh --tools           # YAML-style tool definitions
```
Reads from `.var/pi-traces.jsonl`. Shows the raw prompts sent to the LLM — useful for debugging prompt construction and environment context injection.

### Inspecting agent instructions

To see exactly what system prompt, skills, and context the agent is receiving:
```bash
# Start tailing Pi traces in one terminal:
./scripts/tail-logs.sh --instructions

# In another terminal, trigger a prompt:
rook exec --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN" "hi"
```
The trace logs show the full provider payload including system instructions, skill content, tool definitions, and environment context — everything the agent sees.

### `scripts/run-tests.sh`
Run the known server, Swift package, iPhone, and macOS test/build checks all at once.

## Mac client debugging with Codex

The mac client's sessions list does **not** auto-refresh. Restart to see new sessions:

```bash
./scripts/run-rook.sh mac server
```

Then use Codex — **always specify the full app path** (multiple builds share the same bundle ID):

```bash
codex exec "Use computer use. Interact with the Rook app at /Users/johnberryman/projects/github/rookkeeper/rook/.var/run-rook/build/Rook/Build/Products/Debug/Rook.app. [instruction]" 2>/dev/null
```

Examples:

```bash
codex exec "Use computer use. Interact with the Rook app at .../.var/run-rook/build/Rook/...Rook.app. Tell me what screen it's on." 2>/dev/null
codex exec "Use computer use. Interact with the Rook app at .../.var/run-rook/build/Rook/...Rook.app. Click the session named 'my-test' and report what you see." 2>/dev/null
codex exec "Use computer use. Interact with the Rook app at .../.var/run-rook/build/Rook/...Rook.app. Type 'hi' into the chat input and press enter. Report what happens." 2>/dev/null
```

Key bits: `codex exec` for one-shot, `"Use computer use."` first, always full app path, click sessions by name not position, `2>/dev/null` hides banner.

## Full replay debug workflow

1. Create a named session:
   ```bash
   rook exec --runtime MyPiOpenAiAgent --auth-token "$ROOK_AUTH_TOKEN" --title "replay-test" "ls the directory"
   ```
2. Verify the transcript:
   ```bash
   rook --transcript --sessionId <id> --auth-token "$ROOK_AUTH_TOKEN"
   ```
3. Restart the mac app:
   ```bash
   ./scripts/run-rook.sh mac server
   ```
4. Codex clicks the session by name:
   ```bash
   codex exec "Use computer use. Interact with the Rook app at .../.var/run-rook/build/Rook/...Rook.app. Click the session named 'replay-test'. Describe every message in order." 2>/dev/null
   ```
5. Compare CLI transcript with Codex's report — they should match.

## Common replay bugs

- blocks must be cleared **before** `session/load`, not after — otherwise the runtime's replay events get wiped
- user/assistant/thinking/tool events during replay need separate buffering from active-turn streaming
- `isRunning` must stay `false` during replay so the status dot doesn't glow
