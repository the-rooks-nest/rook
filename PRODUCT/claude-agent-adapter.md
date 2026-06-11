# Claude agent adapter (Pi-style profiles)

## Goal

Let Claude-only users configure agents the way Pi users do today — familiar `agent-profiles.json`, no exposure of `claude-agent-acp`. Internally, same pattern as `PiAgent`: hidden ACP subprocess, standard Claude binary and config.

## User-facing config

```json
{
  "profiles": [
    {
      "id": "MyClaudeAgent",
      "type": "claude",
      "parentId": "ClaudeAgent",
      "command": "claude",
      "args": ["--add-dir", "../my-org-repo"],
      "env": { "ANTHROPIC_API_KEY": "..." }
    }
  ]
}
```

Built-in parent `ClaudeAgent` (like `PiAgent`). Profiles inherit and override.

## Internal wiring (hidden)

| Layer | Implementation |
|-------|----------------|
| Profile type | `"claude"` in `agentProfiles.ts` |
| Adapter class | `ClaudeAgent.ts` (mirror `PiAgent.ts`) |
| ACP subprocess | `node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js` |
| Claude binary | `CLAUDE_CODE_EXECUTABLE` ← profile `command` (default `claude` on PATH) |
| Config | `~/.claude` via `CLAUDE_CONFIG_DIR` (user's normal org/MCP setup) |

Users never specify `claude-agent-acp` in config.

## Pi parallel

```
Pi:     profile args → launcher → pi-acp (ACP) → pi binary
Claude: profile args → ClaudeAgent → claude-agent-acp (ACP) → Claude Agent SDK → claude binary
```

## Arg mapping

Pi forwards `args` literally to the `pi` CLI. Claude's ACP path uses the SDK `query()` API, so profile `args` need translation:

| Profile | Maps to |
|---------|---------|
| `["--add-dir", "../foo"]` | `additionalDirectories` on `session/new` |
| `["--agents", "{...}", "--agent", "pirate"]` | `agents` + `agent` in `_meta.claudeCode.options` |
| `["--append-system-prompt", "..."]` | `extraArgs["append-system-prompt"]` |
| MCP in profile | `mcpServers` on `session/new` |
| Most org setup | Already in `~/.claude` — no profile duplication |

## BaseAgent changes

`BaseAgent` currently sends `session/new` with `mcpServers: []`. `ClaudeAgent` should override session setup to pass profile MCP servers and `_meta.claudeCode.options` (additional dirs, SDK pass-through).

## Dependency

Add `@agentclientprotocol/claude-agent-acp` to `agent-server-client` (same role as `pi-acp`).

## What stays the same (not chopping up Claude)

- Real `claude` executable
- Standard `~/.claude` settings (MCP, models, hooks, permissions config)
- Full Claude Agent SDK — adapter translates SDK events ↔ ACP, does not reimplement tools

## Caveats

- **Permissions UI** goes through Rookery/ACP, not Claude's TUI. Same engine, different approval surface.
- **Not every CLI flag** maps 1:1; interactive TUI flags don't apply. SDK/ACP session options are the right surface.
- **Default `command`** should be `claude` on PATH so users get their installed Claude Code, not only the SDK-bundled binary.

## First slice

1. `ClaudeAgent.ts` + built-in `ClaudeAgent` in registry
2. `type: "claude"` in profiles schema and `agentDiscovery.ts`
3. `--add-dir` arg parsing + env passthrough
4. MCP/orgs from `~/.claude` by default; profile overrides when needed
