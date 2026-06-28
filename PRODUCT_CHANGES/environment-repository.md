# Environment repository redesign sketch

## Goal

Replace the current skill-only, single-directory environment repository model with a layered repository architecture that can serve broader **bundles** for an environment.

Bundles may include, for example:
- skills
- MCP servers
- applications
- other environment-bound assets (TBD)

Each environment is associated with many bundles.

A single bundle is a combination of zero or more:
- skills
- MCP servers
- applications

Some of these must be packaged together so they can be handled as one coherent unit.

## Architectural direction

```text
API (Controllers / Routes)
    ↓
Service (Business Logic)
    ↓
Repository (Data Access)
    ↓
Storage (Filesystem, Postgres, Redis, S3, etc.)
```

We should keep path details, local directory layout, and backend-specific fetch logic below the repository boundary.

## Repository model

Introduce a base abstraction:
- `EnvironmentRepository`
  - declares the common repository API
  - bundle-oriented, not skill-path-oriented
  - storage-agnostic

First concrete implementation:
- `DirectoryEnvironmentRepository`
  - reads environment repository contents from a directory on disk
  - corresponds to the current local-disk implementation direction

Composite implementation:
- `CompositeEnvironmentRepository`
  - presents multiple repositories as one logical repository
  - supports the union view used by Rook

Future likely subclasses:
- GitHub-backed repository
- Remote HTTP/API-backed repository
- other storage/retrieval strategies (TBD)

## Repository roots

Initially support two directory-backed repositories with identical layout:
- canonical repo currently in this monorepo:
  - `environment-repository/`
  - expected to move later into its own GitHub repository
- user-local repo:
  - `~/.rook/environment-repository/`

Runtime model:
- these should be surfaced as one logical repository
- that logical repository is the union of multiple underlying repositories
- this implies a composite repository implementation that wraps multiple `EnvironmentRepository` instances
- every returned bundle should indicate which underlying repository it came from
- precedence / conflict-resolution rules are still TBD

## Bundle direction

The current methods:
- `getSkillPaths`
- `getSkillPreviews`

are too narrow for the new design.

The repository layer should expose **bundles**, not raw skill paths.

Likely direction:
- environment lookup
- bundle listing
- bundle preview / manifest access
- bundle resolution
- repository search (later)

Exact API: TBD.

## Packaging / coherence requirement

A key requirement is that related pieces can be kept together inside bundles.

Examples:
- a skill that assumes a particular MCP server exists
- a skill that depends on an application being installed or registered
- an MCP server and a companion skill that should be approved as one unit

So the directory structure and repository API should support **bundles**, not just independent skills.

More concretely:
- skills keep their existing general shape: named skill directories with `SKILL.md` and optional subdirectories such as references/scripts/assets
- MCP servers will likely be represented in-repo as configuration, not by embedding the full server implementation in the environment repository
- applications should not be stored as full application payloads in the repository; instead the repository will likely carry install/use instructions or other lightweight application-oriented metadata

Exact on-disk structure: TBD.

## Directory storage redesign

The old structure assumed:
- environment → skills

That is no longer sufficient.

New filesystem design should support:
- environment identity
- environment metadata
- bundles
- per-bundle metadata
- previewable content for UI
- enough information to determine requirements / dependencies / compatibility
- lightweight representation of MCP server configuration
- lightweight representation of application requirements / install instructions

Exact filenames, manifests, and folder layout: TBD.

## Agent-facing local authoring interface

Rook itself will also need a simpler interface to the user-local repository at:
- `~/.rook/environment-repository/`

That interface is for authoring / editing environment-specific agent knowledge, not for exposing the full internal repository structure.

Important constraint for now:
- Rook should only speak in terms of **skills**
- Rook should not need to understand the full repository pathing/layout structure
- Rook should be able to ask, effectively, for the skill directory associated with a particular environment in the local repository
- higher layers can translate between that simplified skill-oriented interface and the richer bundle-oriented repository model

So in addition to the general repository API, we will likely need a small agent-facing local-repository interface/adaptor focused on:
- resolve local skill workspace for environment
- list local skills for environment
- create/update local skills for environment

Exact API and how it maps onto the underlying repository structure: TBD.

## Naming cleanup

Standardize on:
- `loc:<slug-or-path>`

and remove the newer `place:<slug>` variant from the codebase.

Implication:
- iPhone client and related docs/code should migrate from `place:` to `loc:`

## Migration notes

We will need to migrate:
- current `LocalEnvironmentRepository`
- current preview APIs
- environment-enter logic that currently assumes skill paths
- existing `environment-repository/` contents to the new layout
- iPhone environment ids from `place:` to `loc:`

Migration plan details: TBD.

Because the environment repository system is still very nascent, it is acceptable for this migration to be destructive if that materially simplifies the redesign and implementation.

## Immediate implementation direction

TBD.

## Remaining Questions

### 1. Core domain model

Answered so far:
- Each environment is associated with many bundles.
- A bundle is a combination of zero or more skills, MCP servers, and applications.
- Bundles are the grouping mechanism for related pieces that should stay together.
- For now, an environment record consists of:
  - `id`
  - `displayName`
  - `description`
- For now, a bundle should also carry a `repository` field indicating where it came from.
  - Initially this may be a path on disk.
  - Later it may point to a Git repository or some other backing source.
- The environment `id` should be a shish-kebab-cased string.
- We expect to revisit and expand the environment record later.

Open questions:
- What metadata is required vs optional on environments and bundles?

### 2. Identity and naming

Answered so far:
- Environments and bundles get identifiers.
- Environment identifier shape:
  - `<type>:<uri-like-path>`
- Bundle identifier shape:
  - `<type>:<uri-like-path>#<bundle-id>`

Open questions:
- Are IDs globally unique or only unique within a repository?
- How do we handle collisions across repositories in the union view?

### 3. Repository composition semantics

Answered so far:
- Multiple underlying repositories are presented as one logical union repository.
- We expect a `CompositeEnvironmentRepository` to wrap multiple `EnvironmentRepository` instances.
- Returned bundles should carry a `repository` field indicating which underlying repository they came from.
- If the same environment exists in two repositories, then that environment should include all bundles across all repositories that list the environment.
- For now, we assume there are no bundle name collisions across repositories and defer collision-handling until needed.
- Bundles from different repositories can therefore coexist under the same logical environment.

Open questions:
- What are precedence / override / shadowing rules?
- Can a local repo patch or augment a canonical environment?
- Do we need explicit merge strategies per entity type?

### 4. EnvironmentManager interaction

Deferred for now:
- approval behavior
- runtime loading behavior
- partial-failure behavior

Those concerns belong to `EnvironmentManager` and are not the focus of this document.

### 5. Agent-facing local authoring model

Answered so far:
- Rook should only speak in terms of skills for now.
- Rook should not need to understand the full repository layout.
- Rook should effectively know where the skills are for a given environment.
- This simpler interface is specifically for the local repo at `~/.rook/environment-repository/`.
- Rook's view into the filesystem may be a simplified façade rather than the true underlying repository layout.
- In practice, what Rook writes to may be symlinked into the underlying local environment repository in the user's home directory.

Open questions:
- What exact simplified interface does Rook get for `~/.rook/environment-repository/`?
- Does Rook create one skill at a time or whole bundles?
- Can Rook edit only skills, or also bundle metadata?
- How do we implement the simplified/symlinked filesystem view for Rook safely and cleanly?
- We need to resolve that filesystem-view mechanism before implementing this.
- Do we want a dedicated service layer just for agent authoring?

### 6. Filesystem structure

Answered so far:
- Skills keep their existing general shape: a named directory with `SKILL.md` and optional subdirectories like `references/`, `scripts/`, and `assets/`.
- MCP servers should be represented in the repository as configuration, not as embedded full server implementations.
- Applications should not be stored as full application payloads; instead the repo should likely store install/use instructions or other lightweight metadata.
- The filesystem should be easy to traverse.
- The top level of the repository is organized by environment type, for example:
  - `app/`
  - `loc/`
  - `web/`
- Environment ids map directly onto nested directories under those type directories.
  - Example: `app:md.obsidian` → `app/md.obsidian/`
  - Example: `app:md.obsidian/reading_vault` → `app/md.obsidian/reading_vault/`
  - Example: `web:news.ycombinator.com` → `web/news.ycombinator.com/`
- Every environment directory may contain a `.bundles/` directory.
- Bundles live underneath `.bundles/<bundle-id>/`.
- Bundle contents are grouped by type underneath the bundle directory, for example:
  - `skills/`
  - `mcp-servers/`
  - `apps/`
- A skill inside a bundle keeps the normal skill shape, for example:
  - `.bundles/using-obsidian/skills/obsidian-cli/SKILL.md`
- A bundle may have only the content types it needs.
  - Example: a web bundle may contain an MCP server config and a skill.
  - Example: a reading-vault bundle may contain only skills.
  - Example: an app-oriented bundle may contain app instructions and skills.
- Application-oriented content can live under `apps/`, for example as `apps/instructions.md`.
- MCP-server-oriented content can live under `mcp-servers/`, for example as `mcp-servers/config.json`.
- Other environment-level information should live in dot directories / dot paths.
  - Environment manifest location: `<environment>/.manifest`
  - Bundle manifest location: `<environment>/.bundles/<bundle>/.manifest`
- There is no separate notion of "preview files" in the environment repository itself.
  - Preview UI elsewhere can render the repository contents in a digestible way.
- State schemas / metadata schemas will probably also live in dot directories, but the exact structure is still TBD.
- Traversal should be shallow for discovery:
  - list top-level type directories
  - descend through environment path directories
  - look for `.bundles/`
  - list bundle directories
  - only then descend into bundle contents
- At minimum, a valid bundle must exist as a named directory under `.bundles/` and contain at least one recognized content-type directory.

Example:

```text
environment-repository/
├── app/
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
├── loc/
└── web/
    └── news.ycombinator.com/
        ├── .bundles/
        │   └── browse-hacker-news/
        │       ├── .manifest
        │       ├── mcp-servers/
        │       │   └── config.json
        │       └── skills/
        │           └── browse-hacker-news/
        │               └── SKILL.md
        └── .manifest
```

Open questions:
- Where exactly should state schemas / metadata schemas live?

### 7. Manifest/data formats

Deferred for now:
- We are not going to decide manifest structure yet.
- We should come back to manifests only once we know exactly what data they need to contain.

### 8. Bundle content type system

Deferred for now:
- We have enough for now with the basic bundle ingredients:
  - skills
  - MCP servers
  - applications
- The more detailed type-system questions are too forward-looking for the current implementation pass.
- We can revisit this once the basic repository and directory-backed implementation are in place.

### 9. State and metadata model

Deferred for now:
- We are not worrying about environment state today.
- We may eventually want dot-directories for state and metadata schemas, but the details are intentionally left open for later.

### 10. Search and discovery

Deferred for now:
- Search/discovery can come later.
- For now, the only required operation is effectively:
  - get an environment by id
  - return all bundles associated with that environment across the logical repository

### 11. Service-layer responsibilities

Answered so far:
- We do still want both a service layer and a repository layer, even though they are close together right now.
- The service layer is almost a pass-through for the current design.
- The service layer should look up an environment and get all of its bundles.
- The repository layer should receive an environment id, go to the expected place on disk, collect the bundles there, and present them back in a canonical TypeScript bundle format.
- Keeping the two layers separate now is still worthwhile because later we may support different storage/retrieval implementations.

Open questions:
- Do we want a separate service specifically for agent authoring, or can that remain a thin layer over the same repository primitives?

### 12. API layer shape

Answered so far:
- This probably should not have an externally facing API yet.
- For now, the service layer is probably sufficient.
- The main consumer right now is `EnvironmentManager`, which will be notified of environments and then needs to look up the associated bundles.

Open questions:
- If/when we expose this outside the service layer, what normalized API shape should it have?

### 13. Validation and integrity

Answered so far:
- The filesystem structure described above largely defines what makes a valid bundle at the repository-structure level.
- Validation of specific content types is a separate concern:
  - skill validation is its own thing
  - MCP-server config validation is its own thing
  - application-content validation is its own thing
- For now, the main validation we need is filesystem-structure validation on read.
- When the agent is interacting with skills for a particular environment, we also need to validate that the relevant structure makes sense.

Deferred for now:
- deeper content validation
- local-authoring validation policy
- lint/check tooling

### 14. Migration and compatibility

Answered so far:
- Destructive migration is acceptable because the environment repository system is still nascent.
- We want to standardize on `loc:` and migrate away from `place:`.
- We are going for a hard cutover.
- We do not want any transitional adapter code because it would muddy the codebase.
- We should hard cut to the new repository design, then fix the tests, docs, and clients that break.
- iPhone migration from `place:` to `loc:` should be simple and is likely just a few hard-coded string replacements.

Open questions:
- Which specific tests/docs/clients break immediately once we cut over?
- In what order do we want to land the code/doc/client updates?

### 15. Security and trust

Deferred for now:
- This is a future concern.
- Yes, different repositories will eventually be treated differently from a trust/security perspective.
- We expect some notion of a canonical repository, while community/user repositories may exist too.
- The details can wait.

### 16. Operational questions

Answered so far:
- Directory-backed environment repositories do not watch the filesystem.
- No caching is needed for now.
- The basic operational flow is:
  - a new environment id arrives
  - we look up that environment in the logical repository
  - we return any bundles associated with it
- Errors should be surfaced in a way the client can show, for example as a toast/pop-up.
- The response path should preserve enough error information for higher layers / API layers to surface it cleanly.

Open questions:
- Exactly what error structure should we use when surfacing repository read/validation failures?

### 17. Testing strategy

Open questions:
- What are the contract tests for `EnvironmentRepository`?
- What behaviors must every subclass satisfy?
- What composite-repository edge cases need tests?
- What fixture repositories should we create?
