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
   `PoiLookupProvider`. The real one, `PtilesPoiLookupProvider`, replicates the
   `steele.red/ptiles` lat/lng → building + business matching server-side:
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
  route; its availability gates live identification.

## 4. Follow-up work

- **Skills at scale (#22).** Author `loc:` skills at the operator/domain level so every
  branch inherits them hierarchically; replace the mocked suggester.
- **Proactive location-triggered agent.** Auto-prompt the agent on environment entry
  (e.g. "you've arrived at X — any pending reminders apply?"), backed by an
  intents/reminders store and **APNs push** delivery (the app is usually backgrounded),
  with cost/consent guards. Enables "remind me to buy milk at the next grocery store."
- **Persistent, per-user presence.** Persist availability and tie it to a user account so
  it survives restarts and a laptop session reliably shares the phone's location.
- **iPhone candidate-picker UI.** Let the user disambiguate when arrival is ambiguous
  ("Are you at Target, Starbucks, or CVS?"); register the chosen candidate.
- **Defer enter-rebuild until idle.** Avoid interrupting an in-flight reply by deferring
  the entry-triggered runtime rebuild until the agent finishes its turn.
- **Broaden store-number coverage** (more chains / URL patterns) and **resolve geo-key
  collisions** (e.g. include a short hash or the business uid for addressless points).
