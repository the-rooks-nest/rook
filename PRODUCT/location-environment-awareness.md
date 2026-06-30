# Location Environment Awareness

Status: implemented (issue [#42](https://github.com/arcturus-labs/rookery/issues/42)).
Scope: turning "the user has arrived somewhere" into available `loc:` environments the
Rook agent can act on.

This is the human-facing product note — what the feature does, what it assumes, where it's
limited, and what's next. The **architecture** (the request/registration flow, the
environment model, the agent bridge) lives in
[AS-BUILT-ARCHITECTURE.md §6.6](./AS-BUILT-ARCHITECTURE.md). Bundle layout is in
[environment-repository.md](./environment-repository.md).

## What it does

When the iPhone detects you've **settled somewhere** (a `CLVisit` arrival at low speed),
it asks the server which businesses you're at. The server reverse-resolves the coordinate
to nearby businesses, picks a **best guess**, and makes that place (plus same-building
neighbors) available to the agent — so the agent gains the place's skills and knows where
you are. In chat you see a banner: the **business name** (or **"Surrounding businesses"**
when it's ambiguous) with a row of business favicons.

The agent receives a place two ways: its **skills** load on demand, and a concise
**best-guess + nearby** summary is pushed into the agent's context so it can answer "where
am I?" directly. The geo provider is **swappable** (ptiles today; a Google Places /
Foursquare `PoiLookupProvider` would be a single class) — the `loc:` scheme and
registration are provider-agnostic.

## Assumptions

- **US-only** ptiles coverage, fetched on demand by HTTP Range (nothing downloads the full
  files); the `.ptiles` data is static and self-hostable (`PTILES_BASE_URL`), so the
  external host is a soft dependency.
- **Single active user / one server process** — environment availability is global
  in-memory state shared by all SessionRooms.
- **Domain ≈ operator identity**; most businesses have a street address, which (with state
  + zip) is the stable, address-based id base. A home or any personal place can be injected
  with the same `loc:` scheme (e.g. `loc:home`).

## Limitations (as-built)

- **Not persisted, not per-user.** The registered location lives in memory, global to the
  process; lost on restart, and on a multi-user server every room would see it.
- **Entering interrupts an in-flight reply.** Entering an environment rebuilds the agent
  runtime (`interruptActiveRun`); the transcript is preserved but a mid-reply arrival cuts
  that reply short (~a couple seconds). Pre-existing for all environment changes; location
  auto-enter just triggers it more often.
- **No authored `loc:` skills yet** — only the synthesized location-context bundle and a
  mocked skill suggester (placeholder for #22).
- **Geo-fallback id collisions.** Addressless businesses sharing a building centroid can map
  to the same `loc:<domain>/<lat,lng>` id (rare; geo only applies with no address).

## Dwell tuning

Registration is gated on a real dwell, not a drive-by. Validated against real OSM GPS
traces (`server/scripts/location/`): ~95% of vehicle detections are <20 s pass-throughs,
while real visits are minutes-long at ~0 m/s. The gate (`isDwellArrival` —
`MIN_DWELL_SECONDS = 30`, `STATIONARY_SPEED_MPS = 1.5`) registers only on a
stationary/dwelled/slow arrival; clearly-moving requests register nothing. No motion signal
⇒ permissive.

On the phone, `CLLocation.speed` plus a CoreMotion automotive check (`arrivalContext`) also
gate the on-device trigger. Motion is a **separate opt-in button in Settings** (never
requested on first launch); without it the speed + server dwell gate still apply.

## Follow-up work

- **Skills at scale (#22).** Author `loc:` skills at the operator/domain level so every
  branch inherits them; replace the mocked suggester.
- **Bundles incl. MCP (#5).** Generalize the runtime bridge from skills to bundles so a
  place can carry MCP servers as well as skills.
- **Split-endpoint UX.** A read-only `/api/environments/identify` exists alongside the
  committing `/api/environments/register-location`; a user-confirmed "which of these is
  real?" picker could use the read-only path instead of auto-entering the best guess.
- **Proactive location-triggered agent.** Have a location change auto-generate a prompt
  ("you're near X — any pending intents apply?"), backed by an intents store and **APNs**
  push, with cost/consent guards ("remind me to buy milk at the next grocery store").
- **Voice as a (meta-)environment.** The interaction modality (voice vs text) is itself an
  environment factor that could carry skills via the same model (`mode:voice`), composing
  with `loc:`. A `VoiceController` already exists in `clients/RookKit`.
- **Capability-gated skills (e.g. store hours).** A store-specific website could drive a
  "look up hours" skill, but doing it right needs a per-agent capability model and
  per-session skill scoping (neither exists yet). The website URL is already in the pushed
  context, so a web-capable agent can answer hours unprompted.
- **Persistent, per-user presence**, an **iPhone candidate-picker** for ambiguous arrivals,
  **deferring the enter-rebuild until idle**, and **broader store-number / geo-collision**
  handling.
