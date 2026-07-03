# Rook

Rook is a local-first personal-agent runtime built around ACP (Agent Client Protocol). The repo contains the server, native clients, and supporting docs.

## Start here

- [Docs index](docs/README.md)
- [Setup](docs/setup.md)
- [Configuration](docs/configuration.md)
- [Product / architecture notes](PRODUCT/)

## Packages

- [server/](server/) — Fastify API, session/runtime orchestration, environment manager, ACP-backed agent adapters
- [clients/mac](clients/mac/) — native macOS menu bar client
- [clients/iphone](clients/iphone/) — native iPhone client
- [clients/RookKit](clients/RookKit/) — shared Swift package for the native clients

## Common entry points

- `./scripts/run-rook.sh server`
- `./scripts/run-rook.sh mac`
- `./scripts/run-rook.sh sim`
- `./scripts/run-rook.sh phone`
- `./scripts/run-rook.sh stop`
- `./scripts/print-environments.sh` — dump active/recent environment diagnostics from the server
- `./scripts/run-tests` — run the known server, Swift package, iPhone, and macOS test/build checks

## High-level docs map

- setup, `.env`, binding, and remote-access notes: [docs/setup.md](docs/setup.md)
- agent-profile config: [docs/configuration.md](docs/configuration.md)
- server package details: [server/README.md](server/README.md)
- iPhone client details: [clients/iphone/README.md](clients/iphone/README.md)
- macOS client details: [clients/mac/README.md](clients/mac/README.md)
