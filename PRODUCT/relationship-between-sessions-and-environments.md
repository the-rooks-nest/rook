# Relationship between Sessions and Environments

An environment is a context the user finds themselves in — a website, a physical location, an app, or any other recognizable domain. Each environment can have zero or more **capability bundles** associated with it. A bundle contains skills, MCP servers, and app instructions that an agent can use while the user is in that environment.

## Bundle decisions are app-wide, not per-session

When a bundle is presented to the user as an environment offer, the user makes a decision about that specific bundle (identified by its content hash). That decision is **app-wide** — it applies to all sessions:

- **Accept** / **Ignore**: ephemeral. The decision lives in memory only while the environment is active. When the environment expires from memory, the decision is forgotten and the bundle can be offered again next time.

- **Approve** / **Reject**: persistent. The decision is stored in the database, keyed by the bundle's content hash (a Merkle tree of every file in the bundle directory). The same bundle will never be offered again — across any session — once approved or rejected.

## How sessions consume environments

When any session wants to join an environment, it receives all bundles of that environment whose **effective decision** is positive (accepted or approved). The session does not make its own decisions about bundles — it inherits the app-wide decisions.

This means:
- If you accept a Lowe's bundle while in your shopping session, then switch to your coding session, the coding session will also gain Lowe's skills if it enters that environment.
- Use "Ignore" (not "Reject") if you only want to skip a bundle for the current visit without affecting other sessions.
- Use "Reject" to permanently opt out of a bundle everywhere.

## What about session-specific concerns?

The product doc previously considered per-session decisions to avoid cross-contamination (e.g., Lowe's skills leaking into a coding session). The resolution is:

1. Sessions don't auto-enter environments from mere availability — they only enter environments the user or agent explicitly joins.
2. Entering a hierarchical child environment implicitly enters its active parent environments too (for example entering `app:md.obsidian/Rooknanigans` also enters `app:md.obsidian`).
3. The agent can help decide whether to enter an environment based on the current session's context.
4. The UI provides affordances to see and manage which environments are active for a session.

If session-specific bundle gating is needed in the future, it would be a separate layer on top of the app-wide bundle decisions.
