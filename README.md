# Agent Station

Monorepo for local Pi agents, an ACP-oriented chat runtime, and host clients/providers.

## Top-level packages

| Package | Role |
|---------|------|
| [agent-server-client](agent-server-client/) | Main app at `:3000`: React UI, Fastify API, session/runtime orchestration, environment manager, and ACP-backed Pi adapter |
| [agent-station-chrome-extension](agent-station-chrome-extension/) | Chrome MV3 environment provider: recognizes supported sites, opens the localhost pane, and directly registers environment availability with Agent Station |
| [agent-station-obsidian-extension](agent-station-obsidian-extension/) | Obsidian sidebar host for the `agent-server-client` app |
| [dummy-client](dummy-client/) | Port-3000 postMessage debug stub |

External dependency: a sibling Pi agent package at `../my-agent/` (not checked into this repo) provides the agent/skill environment referenced by the default Pi profile.

Use the package READMEs above as the main lookup docs for each area.

## Quick start
1. Install **pi.dev / Pi** first, and make sure the `pi` CLI is on your `PATH`.
   Agent Station's ACP-backed Pi adapter still shells out to `pi`; without that install, Pi agents will not start.
2. Make sure the sibling agent package exists at `../my-agent/`.
   This repo expects that path relative to `agent-server-client/`, so the default profile resolves it as `rookery_ai/agent-server-client/../my-agent`.
3. Install the main app deps:
   ```bash
   cd agent-server-client && npm install
   ```
4. Install the Obsidian plugin deps if you are working on that package too:
   ```bash
   cd agent-station-obsidian-extension && npm install
   ```
5. From the repo root, start the main dev stack:
   ```bash
   npm run dev
   ```
6. Open `http://127.0.0.1:3000`

## Pi agent configuration
Default Pi agent profiles live in:
- `agent-server-client/config/agent-profiles.json`

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
- `id`: the agent name shown in Agent Station
- `type: "pi"`: use the built-in Pi-flavored ACP launcher
- `type: "claude"`: use the built-in Claude-flavored ACP launcher
- `parentId: "PiAgent"`: group this profile under the built-in Pi agent
- `args`: extra arguments passed to `pi` before `pi-acp` adds its RPC/session flags

The important bit is:
- Rookery now talks to Pi through **ACP**, not Pi RPC directly
- `-e ../my-agent` still points Pi at the sibling agent package directory
- the Pi launch helper is now generated internally at runtime; there is no checked-in wrapper script to maintain

## `../my-agent/` layout
`../my-agent/` is a separate sibling package, not part of this repo. Agent Station expects it to be your Pi agent/skills workspace.

Typical responsibilities there:
- agent instructions/prompts
- installed or custom skills
- skill metadata and implementations
- any Pi-specific config that belongs to the agent package itself

In short:
- configure **which Pi agent package to launch** in `agent-server-client/config/agent-profiles.json`
- configure **the contents of that agent package** inside `../my-agent/`

If you move or rename the sibling package, update `args` in `agent-profiles.json` accordingly.

## Helpful scripts
- `./scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"` — exercise the server/client bridge without the web UI
- `./scripts/interact-with-remote-agent.sh --raw-acp --agent PiAgent "hello"` — inspect raw ACP JSON-RPC traffic on the bridge
- `./scripts/inject-environment.sh demo:demo` — manually register an environment
- `./scripts/drop-database.sh --yes` — drop the current Agent Station SQLite database

## Monorepo notes
- `agent-server-client/` owns the main npm deps and lockfile for the web app/server
- `agent-station-obsidian-extension/` is a separate npm package
- `environment-repository/` holds local environment-linked skill bundles
- `scripts/` holds repo-level utilities
- `PRODUCT/` holds product notes and evolving architecture docs
