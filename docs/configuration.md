# Configuration

For repo setup, `.env`, server binding, and remote-access notes, see [Setup](./setup.md).

Rook stores user configuration in `~/.rook` by default.

## Config directory

- config root: `~/.rook`
- config directory: `~/.rook/config`
- agent profiles: `~/.rook/config/agent-profiles.json`

## `agent-profiles.json`

`agent-profiles.json` is a JSON object with a top-level `profiles` array.

Each profile can include:

- `id`: name shown in Rook
- `type`: one of `pi`, `claude`, `cursor`, or `acp`
- `parentId`: optional built-in parent, such as `PiAgent`, `ClaudeAgent`, or `CursorAgent`
- `command`: optional executable for generic `acp`/`claude` profiles
- `args`: optional string array of command arguments
- `env`: optional string-to-string environment map
- `cwd`: optional working directory
- `skillPaths`: optional extra skill directories
- `extensionPaths`: optional extra extension directories
- `startupTimeoutMs`: optional startup timeout in milliseconds
- `mcpServers`: optional MCP server definitions
- `model`: optional model override

Example:

```json
{
  "profiles": [
    {
      "id": "MyPiOpenAiAgent",
      "type": "pi",
      "parentId": "PiAgent",
      "args": ["-e", "../my-agent", "--provider", "openai-codex", "--model", "gpt-5.4"]
    },
    {
      "id": "MyClaudeAgent",
      "type": "claude",
      "parentId": "ClaudeAgent",
      "command": "claude",
      "args": ["--add-dir", "../my-org-repo"]
    }
  ]
}
```

A fuller example lives at [`docs/examples/agent-profiles.example.json`](./examples/agent-profiles.example.json).

## Migration from `server/config`

Rook now reads config from `~/.rook/config`.

For compatibility, the server will copy legacy `agent-profiles.json` from `server/config/` into `~/.rook/config/` the first time it loads config, if the new file does not already exist.
