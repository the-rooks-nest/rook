---
description: Build/extend the Rook Android client at full parity with iOS, porting from the Swift sources and tagging each file with its Swift counterpart.
argument-hint: [phase or feature, e.g. "Phase 2 chat" or "voice"]
---

# Goal: Rook Android client at full iOS parity

Build and maintain the **Android client** (native Kotlin + Jetpack Compose) at **feature
parity with the iOS app**. The server needs zero changes — Android is a fourth client
speaking the same REST + ACP-over-WebSocket contract as the Mac and iPhone clients. The
target lives in `clients/android/` (package `com.rookery.rook`).

## Source of truth — port from these, do not modify them
- Protocol: `clients/RookKit/Sources/RookKit/Net/AcpSocket.swift`, `Net/RookAPI.swift`
- Models: `clients/RookKit/Sources/RookKit/Models/{JSONValue,ChatBlocks,ApiTypes}.swift`
- Reducer / app state: `clients/iphone/Sources/RookModel.swift`
- Location: `clients/iphone/Sources/Location/{Place,LocationProvider}.swift`
- Voice / presence: `clients/RookKit/Sources/RookKit/Voice/VoiceController.swift`, `LiveActivity/RookActivityAttributes.swift`
- Chat rendering: `clients/RookKit/Sources/RookKit/Design/{ChatBlockViews,PanelComponents}.swift`
- Screens: `clients/iphone/Sources/Views/*.swift`
- Behavior contract: `clients/iphone/README.md`; canonical wire types: `server/src/shared/{acp,agent,environment,realtime}.ts`

## Non-negotiable convention: reference the iOS code in comments
Every Android file — and every non-trivial function that ports Swift logic — MUST carry a
comment naming its Swift counterpart by path (and symbol when useful):

    // Mirrors clients/RookKit/Sources/RookKit/Net/AcpSocket.swift
    // Mirrors RookModel.handleForegroundApp (clients/iphone/Sources/RookModel.swift) — place in place of app

This continues existing house style — the iPhone app already tags itself against the Mac
app (e.g. `RookModel.swift:310` "Mirrors RookMacModel.handleForegroundApp";
`SessionsScreen.swift:4` "the iOS counterpart of the Mac app's SessionsDetail"). The
maintenance payoff: when a Swift source changes, `grep` its path across `clients/android/`
to find exactly the Kotlin that must change too.

## How to work
1. If `$ARGUMENTS` names a phase/feature, focus there; otherwise continue the next
   unfinished phase in order: **protocol → chat → location→skills → voice → presence →
   frequented-place detection**.
2. Open the referenced Swift file(s) **first**, port the behavior 1:1 into Kotlin/Compose,
   then add the `// Mirrors …` comment(s). Keep the ACP event set and REST surface
   **identical** to `AcpSocket.swift` / `RookAPI.swift` — same message methods, same
   `session/update` kinds reduced, same prompt-completion-from-response semantics.
3. Reuse, don't reinvent: `kotlinx.serialization.json.JsonElement` for the dynamic JSON
   value, OkHttp `WebSocket` + a coroutine `Flow<AcpClientEvent>` for the socket, OkHttp
   for REST, `DataStore` for the place/settings store.
4. Before finishing: re-read the Swift counterpart, confirm no behavior was dropped, and
   note any intentional Android divergence (and the reason) right in the `// Mirrors`
   comment.
5. Verify against the running server: `npm run dev` at the repo root, emulator reaches the
   host via `10.0.2.2:3000` (physical device: the Mac's Tailscale MagicDNS `:3000`).
