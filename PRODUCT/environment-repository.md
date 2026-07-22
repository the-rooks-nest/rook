# Environment repository

This document is the terse product-level description of the environment repository architecture and filesystem shape.

## Purpose

An environment repository is the catalog of environment-linked bundles that Rook can discover and review.

It is intentionally broader than a skill repository.

An environment may have one or more bundles, and a bundle may contain:
- skills
- MCP server configuration
- app-related instructions / metadata
- other environment-bound artifacts later

## Layered architecture

```text
API / controllers
    ↓
Service
    ↓
EnvironmentRepository
    ↓
Storage
```

Current intent by layer:
- **API / controllers** — optional for now; if present, exposes environment/bundle inspection to clients
- **Service** — thin business-logic layer that looks up an environment and returns its bundles
- **EnvironmentRepository** — repository abstraction for reading environments/bundles from one or more backing stores
- **Storage** — filesystem today; other storage types later

## Repository model

We want a shared repository abstraction:
- `EnvironmentRepository`

First implementations:
- `DirectoryEnvironmentRepository`
- `CompositeEnvironmentRepository`

Initially we support two directory-backed repositories with the same layout:
- canonical repo in this monorepo at `environment-repository/`
- local user repo at `~/.rook/environment-repository/`

The monorepo repository is the canonical/shared bundle catalog.
The `~/.rook/environment-repository/` repository is the user-local/personal one.

At runtime these are presented as one logical union repository.

## Environment ids

Environment ids use:

```text
<type>:<uri-like-path>
```

Current top-level environment types we want to standardize around:
- `location`
- `web`
- `project`
- `mac`
- `iphone`
- `android`
- `windows`

Examples:
- `mac:md.obsidian`
- `mac:md.obsidian/reading_vault`
- `web:example.com`
- `web:example.com/stuff`
- `location:office`
- `project:rookkeeper/rook`

## Filesystem shape

Top level is organized by environment type:

```text
environment-repository/
├── android/
├── iphone/
├── location/
├── mac/
├── project/
├── web/
└── windows/
```

Environment ids map directly to nested directories under those type roots.

Examples:
- `mac:md.obsidian` → `mac/md.obsidian/`
- `mac:md.obsidian/reading_vault` → `mac/md.obsidian/reading_vault/`
- `location:office` → `location/office/`
- `project:rookkeeper/rook` → `project/rookkeeper/rook/`
- `web:example.com` → `web/example.com/`

## Bundles

Each environment directory may contain:

```text
.bundles/
```

Bundles live at:

```text
<environment>/.bundles/<bundle-id>/
```

Bundle ids are local to the environment.

Bundle identifiers conceptually use:

```text
<environment-id>#<bundle-id>
```

## Bundle contents

Bundle contents are grouped by type inside the bundle directory.

Current first-pass content directories are:
- `skills/`
- `mcp-servers/`
- `apps/`

Examples:
- `skills/<skill-name>/SKILL.md`
- `mcp-servers/config.json`
- `apps/instructions.md`

A bundle may contain only the content groups it needs.

## Example layout

```text
environment-repository/
├── mac/
│   └── md.obsidian/
│       ├── .bundles/
│       │   └── using-obsidian/
│       │       ├── .manifest
│       │       ├── apps/
│       │       │   └── instructions.md
│       │       └── skills/
│       │           └── obsidian-cli/
│       │               └── SKILL.md
│       ├── .manifest
│       └── reading_vault/
│           ├── .bundles/
│           │   ├── save-documents-to-read/
│           │   │   └── skills/
│           │   │       └── save-documents-to-read/
│           │   │           └── SKILL.md
│           │   └── identify-next-most-important-read/
│           │       └── skills/
│           │           └── identify-next-most-important-read/
│           │               ├── references/
│           │               ├── scripts/
│           │               └── SKILL.md
│           └── .manifest
├── location/
└── web/
```

## Other dot-paths

Other environment-level and bundle-level metadata should live in dot-paths.

Current expected locations:
- environment manifest: `<environment>/.manifest`
- bundle manifest: `<environment>/.bundles/<bundle>/.manifest`

## Preview / review intent

The repository itself does not store separate preview files.

Review UI should render the actual contents of a bundle as a filesystem-style review:
- file tree on the left
- file contents on the right
- bundle errors shown per-bundle
