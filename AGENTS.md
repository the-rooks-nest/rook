# Global Instructions

This is a mono-repo for the Rook personal agent. The agent knows its user AND the agent can be made to interact with the environment around it.

Product/design notes: `PRODUCT/`. When making PRs, make sure to reference anything in this directory and describe how the PR interacts with the current PRODUCT design philosophy and approach. Does it implement a missing feature that product docs is asking for? Does it create a new concept (which you definitely need to add to documentation as part of the PR)? Does it change part of the design philosophy and approach or negate it (In this case, also update the docs as part of the PR)? `PRODUCT/AS-BUILT-ARCHITECTURE.md` is also a good place to look for the current structure. If you notice the structure is being modified from what this document describes, make sure to eventually update this document too.

When making changes:
- Keep tests in sync with code changes.
- I will often ask about GitHub issues, pull requests, and related work. Typically use the GitHub CLI (`gh`) to access, inspect, search, create, and manage those things.
- When I ask you to create a GitHub issue, write it like a person speaking naturally. Do not turn it into a formal template or over-structure it unless I ask for that.
- When issue labeling is relevant, use the repor's current GitHub labels via `gh`. Current preferred labels are: `bug`, `documentation`, `good first issue`, `mac-client`, `iphone-client`, `android-client`, `server`, `environment-repository`, `ui/ux`, and `datamodel`.
- When linking to repo files in chat, prefer markdown links using Zed deep links in the form `[label](zed://file/absolute/path/to/file:line)` when a line number is useful, or `[label](zed://file/absolute/path/to/file)` otherwise.
- When we're working on an issue, it's usually a big enough chunk of work to create a git worktree in `../_worktrees/`. Name it after the issue and topic (for example, `issue-46-tabs`) and use that worktree for the implementation work. After creating the worktree, copy `.env` from the main repo into it (`cp ../rook/.env ../_worktrees/issue-46-tabs/.env`) — it's gitignored so the worktree starts without it, and `run-rook.sh` needs it for remote phone/server config.
- When you make obvious structural or workflow changes, update the relevant READMEs: root `README.md` and the README in whichever major package you touched (`server/`, `clients/mac/`, `clients/iphone/`, `clients/RookKit/`). Also update relevant docs in PRODUCT
- Once you're complete with a large chunk of work, use the mac `say` command to tell me what you've done. Use no more than 7 words. You can background it (e.g. `say '…' &`) so it does not block the shell. Make sure to always end the `say` expression with a sentence-ending punctuation.
- Never push to remote or run `git push` unless I explicitly tell you to. Commit locally all you want.

# Debugging

For debugging patterns, CLI commands, scripts, mock agent usage, and Codex computer-use workflows, read: `.agents/skills/debugging-rook/SKILL.md`.

Quick launch:

```bash
./scripts/run-rook.sh mac server
```

Run a quick diagnostic:

```bash
source .env
rook exec --runtime MockAcpAgent --auth-token "$ROOK_AUTH_TOKEN" "tell me a joke"
```
