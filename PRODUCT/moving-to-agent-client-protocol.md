# Moving to Agent Client Protocol

## Current checkpoint

## Immediate next to-dos

These are the next things we should do, in order:

1. **Browser-check the post-replay-cleanup state.**
   - Product decision stands: chat replay comes from ACP (`session/load`), not from Rookery transcript persistence.
   - `fromSequence` reconnect/replay scaffolding has now been removed.
   - Keep environment decision persistence; it is separate.
2. **Finish the ACP-only cleanup pass.**
   - Confirm deprecated Pi-RPC-era code is actually gone.
   - Confirm there is no compatibility-only replay path left behind.
3. **Finish the non-native ACP adapter pass before the client-state/UI mismatch work.**
   - Treat these like `PiAgent`: thin runtime-specific adapters that enter Rookery through ACP.
   - `ClaudeAgent` is now in place.
   - Next in this sub-phase: Cursor.
4. **Then continue with client-state/UI follow-through.**
5. **Before the farthest-out UI changes, we're going to have a conversation about it.**

Recently completed cleanup:

- removed `MockAgent`
- collapsed `AcpAgent` into `BaseAgent`
- reintroduced a thin `PiAgent` subclass for Pi-specific launch shaping
- removed the checked-in `scripts/pi-with-rookery-profile.mjs` wrapper and generate the Pi launch helper internally at runtime instead
- updated `agent-server-client/config/agent-profiles.json` back to a Pi-shaped profile (`type: "pi"`, `args: ["-e", "../my-agent"]`)
- removed the remaining `fromSequence` / Rookery-owned websocket replay scaffolding

This changes the migration emphasis slightly:

- before continuing deep internal cleanup, we should first make sure our main real agent path (`pi`) actually enters the system as ACP
- once that works, we can simplify much more aggressively because the product no longer needs a Pi-specific runtime protocol path

Last completed checkpoints:

- **Phase 1 / boundary migration checkpoint** is in place.
- The **server/client websocket boundary speaks ACP-shaped JSON-RPC**.
- `pi-acp` worked as a real Pi ACP adapter in this repo.
- Rookery now has a generic **`BaseAgent` ACP stdio subprocess bridge**.
- The built-in `PiAgent` path and `agent-server-client/config/agent-profiles.json` now launch **ACP** instead of Pi RPC directly.
- The old dedicated `PiAgent.ts` Pi-RPC bridge has been removed.
- We validated this with:
  - `scripts/interact-with-remote-agent.sh --agent PiAgent --omit-deltas "hello"`
  - `scripts/interact-with-remote-agent.sh --raw-acp --agent PiAgent "hello"`
  - `scripts/interact-with-remote-agent.sh --agent MyPiAgent --omit-deltas "Reply with the single word ok."`
  - `scripts/interact-with-remote-agent.sh --raw-acp --agent MyPiAgent "Reply with the single word ok."`
  - `cd agent-server-client && npm test && npm run typecheck`

Where we are leaving off now:

- **Boundary protocol:** ACP-shaped
- **Pi subprocess boundary:** ACP-shaped through `pi-acp`
- **Server runtime bridge:** generic `BaseAgent`
- **UI state/reducer:** still legacy `SessionEvent`-driven via translation
- **Transcript persistence:** Rookery-owned durable transcript persistence has been removed from the replay path, and the remaining websocket replay scaffolding has now been deleted

So the next major steps are now:

- **Immediate priority:** browser-check the cleanup checkpoint and confirm nothing deprecated remains
- **Then:** add Cursor and Claude Code adapters as richer non-native ACP test cases
- **Then:** continue with the ACP-friendly UI state work

When resuming work, start by re-running the helper script commands above to confirm both PiAgent and MyPiAgent still behave correctly over ACP.

## Why do this

Rookery's current runtime protocol was designed before we knew about ACP. It solves many of the same problems, but it does so with a custom wire format and a custom event vocabulary.

ACP is a better long-term direction because it gives us:

- a protocol other agent harnesses already speak
- less custom adapter work per agent
- easier interoperability with external editors/clients
- a more standard model for sessions, prompts, permissions, tools, modes, and config

The main conclusion: **we should migrate to ACP and remove the old custom realtime protocol, but do it in staged steps so the app stays working the whole time.**

---

## What we have today

Today, the server/client boundary is built around a custom event stream:

- transport: HTTP + WebSocket
- wire messages: `session_event`, `ack`, `error`
- payload model: custom `SessionEvent` union in `agent-server-client/src/shared/realtime.ts`

Examples of current custom events:

- `status_changed`
- `user_message`
- `assistant_message_started`
- `assistant_message_completed`
- `text_delta`
- `thinking_delta`
- `tool_call_started`
- `tool_input_delta`
- `tool_running`
- `tool_completed`
- `run_completed`
- `run_failed`
- `protocol_error`
- `connection_error`
- `environment_event`

This is not one-to-one with ACP.

ACP instead gives us:

- JSON-RPC messages
- standard methods like `initialize`, `authenticate`, `session/new`, `session/prompt`
- standard notifications like `session/update`
- standard update types like:
  - `agent_message_chunk`
  - `tool_call`
  - `tool_call_update`
  - `plan`
  - `usage_update`
  - `current_mode_update`
  - `config_option_update`
- standard permission flow via `session/request_permission`

---

## Core migration principle

We should **adopt ACP at the server/client boundary first**, then simplify the rest of the app around that.

Important constraint from product direction:

- we do **not** want to leave the old protocol code laying around forever
- we do **not** want a permanent dual-protocol architecture
- we **do** want incremental checkpoints so each step can be tested in a working product

So the plan is:

1. introduce ACP on the boundary
2. temporarily map ACP into the current UI state reducer so the UI still works
3. make the UI state model more ACP-friendly
4. remove the old custom wire protocol and event vocabulary

---

## Recommendation on UI state: preserve it at first, then reshape it

### Why preserve the current UI state model initially

The current UI is not really built around the wire protocol directly; it is built around a **presentation-oriented reducer state** in `ChatPanel`.

That state is roughly:

- transcript `blocks`
  - user text blocks
  - assistant text blocks
  - thinking blocks
  - tool blocks
  - error blocks
- `isAgentProcessing`
- a displayed `status`
- queued messages

This state is useful because it is already tuned for rendering concerns:

- streaming text append
- streaming thinking append
- tool lifecycle rendering
- error display
- queued-message UX
- replay hydration

In other words, the current reducer state is really a **view model**, not just a protocol mirror.

If we throw that away too early and make the UI consume raw ACP everywhere, we would make the UI more coupled to protocol mechanics:

- raw JSON-RPC envelopes
- partial update sequencing
- permission request/response mechanics
- transport concerns
- complete-vs-incremental replacement semantics for some ACP updates

That would likely slow us down.

### Why we should still make it more ACP-friendly

Preserving the current UI state model at first does **not** mean keeping it unchanged forever.

Right now the reducer shape is heavily influenced by the old custom `SessionEvent` vocabulary. That makes ACP adoption harder than it needs to be.

A better target is:

- keep a UI-facing view model
- but make that view model align with ACP concepts more directly

That would make future development easier because new features could map naturally from ACP instead of first being squeezed into custom event names.

### Nice aspects of making the UI/UX a closer analog to ACP

There are real product and engineering benefits if the UI becomes more ACP-shaped over time.

#### 1. New protocol features become product features faster

If the UI already has first-class concepts for:

- permission requests
- plans
- usage updates
- mode/config updates
- stop reasons

then we can expose those features directly instead of inventing custom intermediate events every time.

#### 2. Less impedance mismatch between protocol and UI

Today the system has to translate provider/runtime activity into custom events and then into UI state. A more ACP-friendly UI model reduces that translation burden.

Benefits:

- fewer one-off adapter rules
- less lossy transformation
- fewer places where protocol detail gets dropped and has to be reconstructed later

#### 3. Easier debugging and inspection

When UI concepts line up with ACP concepts, it becomes easier to reason about the system with tooling like:

- raw ACP traces
- Cursor ACP experiments
- future ACP-compatible harnesses
- replay logs
- `scripts/interact-with-remote-agent.sh` during migration testing

That gives us a better path for debugging because what we inspect on the wire is much closer to what the UI actually understands.

#### 4. Better support for multi-agent / external-agent future work

If we want more external harnesses later, an ACP-shaped UI will be less biased toward the quirks of today's custom protocol and more reusable across providers.

#### 5. Cleaner long-term mental model

A protocol-shaped UI model gives us clearer product language:

- prompt turn
- message chunk
- tool call
- permission request
- plan update
- config update
- stop reason

That is easier to explain, document, and extend than an accretion of custom event names.

### Concerns and challenges when making the UI more ACP-friendly

This is attractive, but it is not free.

#### 1. ACP is still protocol-shaped, not presentation-shaped

Some ACP concepts map cleanly to UI, but others are still too low-level to drive rendering directly. We should not confuse a better protocol alignment with a full removal of view-model concerns.

Examples:

- JSON-RPC envelopes are not UI state
- request/response correlation is not UI state
- replay ordering concerns are not UI state
- some ACP updates replace full state while others append incrementally

So even in an ACP-native future, we will still want a rendering-oriented state layer.

#### 2. We may overfit the UI to today's reading of ACP

During migration we will learn more about:

- replay needs
- permission UX
- multi-session semantics
- how different harnesses actually use ACP in practice

So we should avoid locking in a UI state shape too early. The UI should move toward ACP, but not freeze prematurely around our first draft.

#### 3. Some current UX affordances are custom and useful

Things like:

- synthesized status text
- the current block model for streaming text/tool rendering
- local transport error synthesis
- queued-message UX

may still be worth keeping even if they are not ACP concepts. We should not discard useful UX just to become protocol-pure.

#### 4. Permission UX may change the shape of the chat surface

ACP makes permission requests first-class. Once we support them properly, we may need to revisit:

- where permission prompts render
- whether they appear inline vs modal
- whether plans and permissions are part of the transcript vs side panels
- how mode/config changes are presented

That is product design work, not only protocol work.

#### 5. Replay and partial updates become more explicit

An ACP-friendlier UI will likely force us to be more explicit about:

- grouping chunks by message id
- handling multiple concurrent or interleaved update types
- replacing plan/config state correctly
- distinguishing prompt completion from stream completion

That is good long-term, but it does make the reducer design more deliberate.

---

## What an ACP-friendlier UI state would look like

Instead of centering the UI around custom event names, center it around ACP concepts.

### Suggested UI-facing model

#### Session lifecycle state

- connection state
- authentication state
- active session id
- prompt/run state
- stop reason for last completed turn

#### Conversation entries

Represent the transcript in terms closer to ACP:

- user messages
- agent message chunks grouped by `messageId`
- plan state
- tool calls keyed by `toolCallId`
- permission requests keyed by request/tool call
- usage snapshots / latest usage state
- mode/config state
- recoverable protocol/transport errors

#### Tool state

ACP tool concepts map well to a stable UI model:

- pending tool call
- in-progress tool call
- completed tool call
- failed/cancelled tool call
- optional streamed content/results
- permission state

#### Config/mode state

Keep first-class state for:

- `modes`
- `configOptions`
- current mode
- current model / thought level if exposed as config

That lets us support ACP-native controls later without redoing the state model again.

### Concretely, what should change in the UI model

Over time we should move away from these old event-driven assumptions:

- `run_completed` as a synthetic standalone event
- `status_changed` as the primary truth source
- separate `assistant_message_started` / `assistant_message_completed` events
- separate tool input/output delta event names that exist only because of the current custom protocol

And move toward these ACP-native state sources:

- prompt completion comes from the `session/prompt` response and `stopReason`
- transcript content comes from `session/update`
- tool lifecycle comes from `tool_call` + `tool_call_update`
- permissions come from `session/request_permission`
- plans come from `plan`
- config/mode changes come from `config_option_update` / `current_mode_update`

So: **preserve the UI view-model idea, but refactor it to be ACP-shaped.**

---

## Migration strategy

## Phase 0 — document the mapping and choose the cut line

Before code changes, write down:

- current custom wire messages and event types
- ACP equivalents
- missing ACP concepts we need
- which UI state should remain view-model-only vs protocol-derived

Deliverable:

- protocol mapping doc
- agreed cut line: ACP begins at the server/client boundary

Success criteria:

- we know exactly what gets deleted later
- we avoid accidental permanent compatibility layers

---

## Phase 1 — add an ACP boundary adapter

First implementation step:

- change the server/client boundary to speak ACP-shaped messages
- keep the existing UI working via a temporary ACP -> UI adapter

This adapter can live on either side of the boundary, but server-side is probably cleaner because:

- agent runtimes are already protocol adapters (`PiAgent` and generic ACP subprocesses)
- replay/logging can become ACP-shaped earlier
- we avoid carrying custom event semantics out over the wire

### Candidate design

Server runtime side emits ACP-ish events/notifications internally, or at least enough information to produce them.

Then the boundary layer:

- exposes JSON-RPC-compatible ACP messages over WebSocket initially
- maps incoming ACP messages to existing runtime operations
- maps outgoing runtime activity to ACP notifications/responses

For a short transition period only, client code can translate incoming ACP notifications into the current reducer actions.

Deliverable:

- ACP-shaped websocket stream between server and browser client
- temporary ACP -> current UI reducer adapter

Success criteria:

- chat still works end to end
- replay still works
- no visible UX regression
- wire traffic is ACP-shaped, not `session_event`-shaped

Important note: this is the one temporary adapter we should allow. We should **not** keep both old and new wire protocols around long-term.

---

## Testing and validation during migration

We already have a very useful non-UI harness for checking incremental changes:

- `scripts/interact-with-remote-agent.sh`

This should be a primary validation tool during migration because it lets us exercise the server/client bridge without involving the browser UI.

Use cases during ACP migration:

- verify that server-side protocol changes still produce coherent streamed output
- compare old vs new event shapes during intermediate steps
- inspect replay behavior
- test session restart / resume behavior
- smoke-test remote-agent bridge changes before touching the UI

We should prefer validating each migration phase here first, then in the full UI.

---

## Phase 2 — make replay/storage ACP-native

Once the boundary is ACP-shaped, persist and replay ACP-native messages or ACP-native session updates instead of custom `SessionEvent`s.

Today replay is tightly coupled to the custom event union. That should change.

Target:

- event persistence stores ACP-compatible outbound notifications/responses, or a normalized ACP event log
- reconnect/replay replays ACP-shaped data

Deliverable:

- session event storage no longer depends on old `SessionEvent`

Success criteria:

- reconnect/replay works with ACP messages only
- old `SessionEvent` persistence path can be deleted

---

## Phase 2.5 — add Cursor and Claude Code adapters before the client refactor

Before reshaping the client reducer, add non-native ACP adapters for Cursor and Claude Code.

Why do this now:

- they do not natively speak ACP in the same way Pi now does inside Rookery
- they have richer forms of interaction than Pi
- they will give us better traces and better pressure tests for the boundary before we change client state

This should be treated like the `PiAgent` step:

- keep adapters thin
- make them enter Rookery through ACP-oriented boundaries
- do not reintroduce protocol sprawl

Deliverable:

- Cursor adapter
- Claude Code adapter
- enough raw ACP and translated traces to inform the next UI/client-state step

Success criteria:

- both runtimes can be exercised through the existing script/debug path
- adapter code remains simpler than the old custom-runtime approach
- we learn from richer interactions before reshaping the reducer

---

## Phase 3 — refactor the client reducer into ACP-friendly UI state

This should be treated as the **next big step after the server/client interaction boundary is ACP-shaped and stable**.

It is important, but we should not rush it before we have learned from:

- the boundary adapter implementation
- ACP-native replay/storage work
- real traces from `scripts/interact-with-remote-agent.sh`

Now update the browser client so it no longer thinks in terms of old custom event names.

Replace:

- `applyServerEvent(SessionEvent)`

with something more like:

- `applyAcpMessage(JsonRpcMessage)` or
- `applyAcpUpdate(SessionUpdate | PermissionRequest | PromptResult)`

At the same time, reshape state to include:

- plan state
- permission request state
- usage state
- mode/config state
- stop reasons

Deliverable:

- UI reducer and state are ACP-oriented
- temporary ACP -> old-action translation layer removed

Success criteria:

- UI behavior remains good
- protocol concepts map directly to UI state
- new ACP features can be added without inventing custom event types

---

## Phase 4 — remove old custom protocol types and code

After the client reducer no longer depends on `SessionEvent`, remove the old custom protocol code entirely.

Delete candidates include:

- `src/shared/realtime.ts` custom `SessionEvent` union
- `session_event` / `ack` / `error` websocket message model
- custom event translation logic in `RemoteAgent`
- custom reducer action wiring based on old event names
- old tests that exist only for the custom protocol

Success criteria:

- there is only one boundary protocol: ACP
- no hidden dependency on legacy event names remains
- new agents can integrate by speaking ACP, not by implementing custom Rookery events

---

## Phase 5 — extend UI/UX to actually use ACP features

After the protocol migration is complete, add UX for ACP concepts we do not really support today:

- permission dialogs from `session/request_permission`
- plans
- usage/cost/context window updates
- mode switching
- config options (mode/model/thought level)

This is where ACP becomes not just a transport change, but a product capability upgrade.

---

## What to delete eventually

We should be explicit that these are transition-only pieces:

- any ACP -> old-SessionEvent adapter
- any old-SessionEvent -> ACP compatibility layer
- any duplicated replay format
- any dual wire protocol support

Principle:

- **temporary adapters are acceptable only to preserve working increments**
- **permanent dual models are not**

---

## Risks / complexity

### Medium difficulty

This is not trivial, but it is also not a ground-up rewrite.

Why it is feasible:

- the product already has sessions, prompts, streaming text, tool lifecycle, replay, and resumability
- those concepts overlap heavily with ACP
- the biggest mismatch is vocabulary and message framing, not product architecture

### Main sources of complexity

- replay/store migration
- converting WebSocket messages from custom envelopes to JSON-RPC-style ACP messages
- permission flow (`session/request_permission`) because it is not first-class in the current model
- preserving current UX while changing protocol semantics underneath

### Main UI/UX risk

The main risk is not visual design confusion; it is state-model confusion during the transition.

There is also a real product-design risk: once plans, permissions, usage, and config updates are first-class, we may discover that the current chat-only presentation is not the right long-term surface for all of them.

That happens if we temporarily stack too many layers:

- runtime events
- ACP adapter
- old SessionEvent adapter
- reducer actions
- block view model

So we should keep the transition shallow and remove obsolete layers quickly.

---

## Recommended implementation order

1. **Define the target boundary protocol in ACP terms**
2. **Add ACP-shaped server/client messages**
3. **Use one temporary adapter to keep the current UI running**
4. **Move replay/storage to ACP-native data**
5. **Add Cursor and Claude Code adapters as richer non-native ACP test cases**
6. **Refactor UI state to be ACP-friendly**
7. **Delete old custom protocol code**
8. **Add richer ACP-native UX**

---

## Short recommendation

- **Yes, move to ACP.**
- **Do it incrementally.**
- **Adopt ACP at the boundary first.**
- **Preserve the current UI view-model initially, but reshape it to be ACP-friendly.**
- **Delete the old protocol once each increment is proven.**
