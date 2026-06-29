# Location Environment Awareness (as-built)

Status: implemented (issue [#42](https://github.com/arcturus-labs/rookery/issues/42), phases 1 + 6/8)
Scope: turning "the user has arrived somewhere" into available `loc:` environments
the Rook agent can act on.

This documents what was built, the assumptions it rests on, its current limitations,
and the follow-up work. See also
[relationship-or-environments-skills-and-agent.md](./relationship-or-environments-skills-and-agent.md),
[skills-definitions.md](./skills-definitions.md),
[AS-BUILT-ARCHITECTURE.md](./AS-BUILT-ARCHITECTURE.md) (§6 environments), and
[PRODUCT_CHANGES/research/rook-on-iphone.md](../PRODUCT_CHANGES/research/rook-on-iphone.md)
(push/presence).

## 1. Overview — the end-to-end flow

1. **iPhone trigger.** `LocationProvider` (`clients/iphone/Sources/Location/`) listens for
   `CLVisit` arrivals and gates them: it only fires when the device looks **settled and
   not driving** (low `CLLocation.speed` plus a `CMMotionActivityManager` non-automotive
   check). `RookModel.identifyEnvironments` then POSTs the coordinate + context.

2. **Identify API.** `POST /api/environments/identify-available` takes
   `{ latitude, longitude, horizontalAccuracy?, source?, dwellSeconds?, isStationary?,
   speedMetersPerSecond?, observedAt? }` and returns ranked `EnvironmentCandidate`s
   (server type in `server/src/shared/environment.ts`).

3. **Server-side lookup (ptiles).** `EnvironmentIdentifier` calls a pluggable
   `PoiLookupProvider` (`server/src/server/location/PoiLookupProvider.ts`). The real
   one, `PtilesPoiLookupProvider`, replicates the `steele.red/ptiles` lat/lng →
   building + business matching server-side. **The provider is swappable**: replacing
   ptiles with the **Google Places API**, **Foursquare**, or similar is a single new
   `PoiLookupProvider` class — `EnvironmentIdentifier`, the `loc:` id scheme, the
   in-building tightening, and registration are all provider-agnostic and unchanged.
   The ptiles implementation:
   - All external data is fetched through a single egress proxy route,
     `GET /api/ptiles/proxy` (`routes/ptilesProxyRoutes.ts`), which forwards **HTTP
     Range** requests to `maps.mydatatimeline.com` for allowlisted files only. Nothing
     downloads the full 16–53 MB files — only the header + index + dict + the one H3
     cell block per query (`ptiles/PtilesRangeSource.ts`, zstd via Node's `node:zlib`).
   - `AdminReader` resolves the US state from `US.admin.ptiles`; `BuildingsReader` does
     point-in-polygon (else nearest within 50 m); `BusinessReader` decodes nearby
     businesses (name, operator/brand, address, website, phone, chain count).

4. **Stable ids.** `locationKey` builds an **address-first** id:
   `loc:<domain>/<state-zip-street>` with any **store number appended for precision**
   (`…/store-729`); a rounded `lat,lng` (building centroid when inside one) is used only
   when there is no address. Domain comes from the business website host (else an alias
   table); store numbers come from per-chain website-URL regexes (`storeNumber.ts`,
   validated against real data). Ids are self-describing / re-queryable — nothing is
   stored.

5. **Tightening.** `restrictToPlace` keeps only the businesses **inside the matched
   building footprint** (or within a 2 m buffer if none), otherwise those within **10 m**
   of the point — so standing in one store surfaces that store and its same-building
   neighbors, not a city block.

6. **Registration into the SessionRoom/agent (#6/#8).** On each identify,
   `LocationRegistrar.sync` makes the set available through the existing environment flow:
   - the top-ranked **best-guess "current"** business is registered with full metadata
     and a synthesized **location-context skill** (`LocationContextSkill.ts` writes a
     `SKILL.md` listing the current business + same-building shops + website/lat-lng),
     then **auto-entered** (`decideEnvironment(…, "accept")`) so the agent gets the
     context immediately;
   - **same-building neighbors** are registered too, so any of their hierarchical skills
     load (a bundle at `loc:homedepot.com` is inherited by every store);
   - the set is **replaced on each identify** (unchanged sets are skipped to avoid agent
     churn; an empty result unregisters everything).
   - `EnvironmentManager.registerAvailableEnvironment` gained an optional
     `extraSkillPaths` so an otherwise skill-less env surfaces and carries the context.

## 2. Assumptions

- **US-only coverage**, sourced from `maps.mydatatimeline.com` (`<ST>.buildings_v8.ptiles`,
  `<ST>.business.ptiles`, `US.admin.ptiles`), H3 resolution-7 tiling, `Accept-Ranges`
  supported.
- **Single active user / one server process.** Environment availability is global
  in-memory state shared by all SessionRooms on that process.
- **Domain ≈ operator identity.** `loc:` ids key on the operator's web domain.
- **Most businesses have a street address**; that address (with state + zip) is the
  stable id base.
- **Store numbers are best-effort** — only present when the chain encodes them in the
  website URL.
- **The ptiles data is static and self-hostable.** The `.ptiles` files are immutable,
  range-served blobs and the proxy route abstracts the origin via `PTILES_BASE_URL`, so
  Rook can host them itself (own storage / CDN) instead of relying on a third party.
- **Manual / home `loc:` injection is trivial.** Because ids are just `<kind>:<path>`,
  a home (or any personal) location can be injected with the same `loc:` scheme (e.g.
  `loc:home`) — no special-casing — so a user's home-specific skills attach through the
  same hierarchical model as business `loc:` environments.

## 3. Limitations (as-built)

- **Not persisted, not per-user.** The registered location lives in memory and is global
  to the process. It is lost on server restart and is not scoped to a user/account, so on
  a multi-user server every room would see it.
- **Agent receives metadata only via the context skill.** The agent runtime still loads
  only skill *files*; there is no separate channel handing the agent the `environmentId`
  or structured metadata. The synthesized `SKILL.md` is how the current/nearby metadata
  reaches the agent.
- **Entering interrupts an in-flight reply.** `onEnvironmentEntered` rebuilds the agent
  runtime with `interruptActiveRun: true`, cancelling any active response. The transcript
  is **preserved** (the new agent resumes via `session/load`) and the chat is **not
  cleared** — but a mid-reply arrival cuts that reply short and restarts the agent (~a
  couple seconds). This is pre-existing behavior for all environment changes; location
  auto-enter just triggers it more often.
- **Geo-fallback id collisions.** Addressless businesses on the same domain that share a
  building centroid can map to the same `loc:<domain>/<lat,lng>` id. Rare (geo only
  applies with no address).
- **No real `loc:` skills exist yet.** Only the synthesized context skill and the mocked
  `BuildingSkillSuggester` (placeholder for #22). Skill-less neighbors don't create their
  own offer; they're represented inside the current env's context bundle.
- **`maps.mydatatimeline.com` is an external dependency** reached only through the proxy
  route; its availability gates live identification — but the `.ptiles` files are static
  and could be trivially self-hosted by Rook (flip `PTILES_BASE_URL`), making this a soft
  dependency rather than a hard one.

## 4. Business context without skills

Business metadata is injected into the agent's context **even when no skills exist** for
that place. The synthesized location-context skill is always attached to the current env
(via `extraSkillPaths`) and auto-entered, so the agent immediately has the current
business + same-building neighbors with their `loc:` ids, operator, address, website, and
coordinates.

This already enables metadata-grounded answers with zero authored skills — e.g. the agent
can answer "what's this store's website / address?" directly, and "what hours is it open?"
by **following the injected website link**. Caveat: ptiles supplies the website URL, not
live hours, so hours (and anything not in the metadata) require the agent to fetch the
site.

## 5. Dwell tuning & data validation

Validated against real OSM GPS traces (pedestrian/cycling/vehicle, NC/TN) via
`server/scripts/dwell-analysis.ts` (corpus in `validation-traces.manifest.json` +
`fetch-validation-traces.ts`; committed fixtures in `location/test-fixtures/gpx`).

Findings (replaying each timestamped point through the matcher and measuring per-place
**dwell** = the time span of consecutive points matched to one place):
- **Pass-throughs dominate continuous motion.** Vehicle traces: ~95% of detections are
  **<20 s** (most <5 s, 8–12 m/s) — driving past a roadside business. Cycling: ~93% <20 s.
- **Real visits separate cleanly:** they are **minutes-long at ~0 m/s** (e.g. a 28-min
  gas-station stop, a 6-min in-building ATM), vs the brief, fast drive-bys.
- The per-point identify had **no dwell gate**, so a continuous location stream would
  register dozens of fly-bys.

Tuning applied: **registration is now gated on the request's own dwell/motion signal**
(`isDwellArrival` in `LocationRegistrar` — `MIN_DWELL_SECONDS = 30`,
`STATIONARY_SPEED_MPS = 1.5`). The identify endpoint still **returns** the candidate list,
but only **registers** the location into the SessionRoom/agent on a stationary/dwelled/slow
arrival; clearly-moving requests register nothing. This composes with the on-device CLVisit
gate (`LocationProvider.arrivalContext`) and works for both a parked car (0 m/s, sustained)
and someone standing in a store. No motion signal ⇒ permissive (back-compat).

> **Data limitation — building index.** Building-footprint matching needs a per-state
> ptiles `buildings_v8` index. A survey found **only NC and TN have a valid index today**;
> every other surveyed state ships an empty index (`indexLength=4`, count 0) despite having
> blocks, so in-building precision (inside-vs-near, same-building grouping) silently
> degrades to the 10 m business radius there (business identification still works). The
> provider now logs a one-time warning per such state. Fix is upstream: re-export the
> `buildings_v8` files with proper indexes.

## 6. Follow-up work

- **Skills at scale (#22).** Author `loc:` skills at the operator/domain level so every
  branch inherits them hierarchically; replace the mocked suggester.
- **Proactive location-triggered agent.** Have a **location change auto-generate a
  prompt to the agent** on entry ("you've entered / are near X — do any pending user
  intents apply?"), backed by an intents/reminders store and **APNs push** delivery (the
  app is usually backgrounded), with cost/consent guards. Enables "remind me to buy milk
  at the next grocery store" firing when the user enters or is near a grocery store.
- **Favicon on entry (client).** Show the business's favicon (derived from its website
  domain) when entering a `loc:` business, for quick visual presence in the UI.
- **Voice as a (meta-)environment.** The modality the user is interacting through — voice
  vs. text — is itself an environment factor that could carry skills, the same way a
  `loc:` place does. A `mode:voice` (or similar) environment could attach voice-tuned
  skills/behaviors (shorter, TTS-friendly responses; barge-in/turn-taking conventions;
  read-aloud formatting), entered while the user is talking and exited when they switch
  back to text. It generalizes the environment model beyond physical/app context to
  **interaction context**, and composes with `loc:` (e.g. voice + in-a-store). The
  iPhone/Mac already have a `VoiceController` (`clients/RookKit`) that could act as the
  provider.
- **Capability-gated skills (e.g. "look up store hours").** A *store-specific* website (a
  deep link to this location, not a chain homepage like `kroger.com`) could drive a
  synthesized "look up hours" skill — hours are usually a single GET away. Doing it right
  needs two things the codebase lacks today: (a) a **per-agent capability model** —
  `AgentDefinition` (`server/src/shared/agent.ts`) has no notion of whether the backend can
  fetch the web (Claude agents can, via WebFetch/Bash; Pi and others may not), so it isn't
  introspectable; and (b) **per-session/per-agent skill scoping** — environment skills
  currently attach **globally** (`LocationRegistrar` doesn't know which agent will enter
  them), so a skill can't be gated on the running agent. Until both exist, such a skill
  would fire for agents that can't act on it. (Note: the website URL is already in the
  injected context metadata, so a web-capable agent can answer "what are the hours?"
  unprompted — see §4.)
- **Persistent, per-user presence.** Persist availability and tie it to a user account so
  it survives restarts and a laptop session reliably shares the phone's location.
- **iPhone candidate-picker UI.** Let the user disambiguate when arrival is ambiguous
  ("Are you at Target, Starbucks, or CVS?"); register the chosen candidate.
- **Defer enter-rebuild until idle.** Avoid interrupting an in-flight reply by deferring
  the entry-triggered runtime rebuild until the agent finishes its turn.
- **Broaden store-number coverage** (more chains / URL patterns) and **resolve geo-key
  collisions** (e.g. include a short hash or the business uid for addressless points).
