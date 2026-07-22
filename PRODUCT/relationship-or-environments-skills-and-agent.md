# Environments, skills, and the Rook agent

The Rook agent is isolated from environment internals for security. It learns what to do from skills, but the skills only provide a narrow means of communication w/ the environment (see [[narrow-skills-environment-bridge]]).

## Environment

Core object. It has a URL-like identifier: `<kind>:<unique-path>` (e.g. `web:en.wikipedia.org/wiki/Julius_Caesar`, `mac:md.obsidian/MyVault/Projects/Foo`, `location:lowes.com/store-1234`, `project:rookkeeper/rook`). And is associated w/ metadata (display name, provenance, other fields TBD). An environment has an arbitrary state which changes over time that we will _somehow_ communicate to the Rook agent (Also TBD). And an environment is associated with Skills that allow the agent to interact with it and draw information from it.

Current top-level environment kinds are:
- `location`
- `web`
- `project`
- `mac`
- `iphone`
- `android`
- `windows`

IDs are hierarchical; narrower IDs may imply broader ones (`web:reddit.com/r/foo` ⊂ `web:reddit.com`). Multiple overlapping envs can be active at once. Skills and state can be associated w/ any level of environment.

For some terminology, there are many "known" environments (ones that are available in an environment repository somewhere). The "available" environments are the ones that the Rook can currently choose to enter (like if you're at Home Depot, then `location:homedepot.com/store-4321` will be available; if you're using Obsidian on the Mac, then `mac:md.obsidian/HomeProjects/ToDos` could be available; if you're working on the Rook repo, then `project:rookkeeper/rook` could be available). And an environment is "entered" if the current session has loaded its skills and is accepting its state changes. (Though it is also possible to request to enter environments that aren't available - like if you want the Rook to know how to navigate a Home Depot even though you're not there. Implementation and UX TBD)

## Environment repositories

Catalog of environment → bundle content. Same API whether local disk or remote HTTP/Git.

See also: [`PRODUCT/environment-repository.md`](./environment-repository.md)

**Logical model:**

```text
EnvironmentRepository
  └── environments[]
        └── environment   # id + metadata
        └── skills[]
              └── skill   # id + metadata + SKILL.md body
              └── references[], scripts[]
```

**Types of environment repositories:**

- **Canonical** — curated, trusted catalog (official Rook repo; today lives at `environment-repository/` in monorepo)
- **Local** — user-owned disk repo for personal envs/skills – not built as separate path yet; same directory-backed repository backend, different root – users can some somehow instruct the Rook agent to add and update skills in environments.
- **External** — repositories from other providers

And environment repository needs to be searchable so that you can find environments and skills that might be useful.

## EnvironmentManager

Runtime coordinator that serves as a connection between Rook agents, the environments, and the skills. It also remembers skill choices.

When a new environment becomes available, then the environment manager offers it to the running agents (which are currently represented as SessionRooms - but this might change). And the user can review the skills of that environment and "allow once", "allow always", "reject", "ignore".

- If "allow once" or "allow always", the skills are injected into the running session.
- If "reject" or "ignore", then the skills are not injected.
- If "allow always" then the skills are cached locally, and every time the environment becomes available, the user/agent will automatically enter it and get the cached skills. If the skills are modified by the environment provider, then the users will be again asked to approve.
- If "reject" then this decision will be saved, and when the environment becomes available, it will not be entered. The user can revisit these decisions later.
- On the UI we need some way to represent the number of environments available and entered. And when they click on this they can modify past decisions - TBD.
