# Rook for iPhone (native SwiftUI)

A native iOS app that makes [Rook](../../README.md) **location-aware**: as
you arrive at a place you've defined, Rook registers `place:<slug>` with the
server and the agent gains that place's skills — the physical-location analog of
the Chrome extension's `web:<slug>` and the Mac menu bar app's `app:<slug>`.

The iPhone is a **fourth environment provider**. Its signal is GPS/geofence
instead of a frontmost app or a browser tab, but it speaks the same REST + ACP
contract to `:3000` and needs **zero server changes** — `place:office` resolves
to `environment-repository/place/office/` exactly the way `web:wikipedia`
resolves to `environment-repository/web/wikipedia/`.

UI, networking, models, chat rendering, and voice are shared with the macOS menu
bar app through the [`RookKit`](../RookKit/) Swift package, so the two clients
share one look and one protocol layer.

## What it does

- **Location → skills (the core loop).** Define places (name + GPS center +
  radius). `LocationProvider` monitors each as a `CLCircularRegion`. Entering a
  region builds `place:<slug>`, pre-checks the server for matching skills
  (`GET /api/environments/preview`), and if any exist registers the environment
  (`POST /api/environments/register`) with `latitude`/`longitude`/`regionId`
  metadata. The server pushes an offer over the session websocket; you approve
  with the same 2×2 decisions as every other client; the place's skills load
  into the agent. Leaving the region marks it unavailable
  (`POST /api/environments/unregister`).
- **Full chat parity.** Agent picker, session start/resume, streaming ACP chat
  (text, thinking, tool calls, plans, errors, context usage) — all rendered by
  RookKit's shared chat views, the same code the Mac app uses.
- **Voice (hands-free).** Tap-to-talk in the chat screen: on-device speech
  recognition (`SFSpeechRecognizer`) sends your words as the prompt;
  `AVSpeechSynthesizer` speaks the reply once the turn completes. The shared
  `VoiceController` adds an iOS `AVAudioSession` (`.playAndRecord`,
  `.spokenAudio`) so capture and playback coexist.
- **Live Activity / Dynamic Island.** The lock screen and Dynamic Island show
  the current place, whether skills are loaded, and the agent's status
  (idle/working) — for an active chat *or* ambiently when you're at a
  place with skills loaded (no chat needed). Implemented natively with
  ActivityKit + a `RookWidgets` app-extension target; tapping the card
  (`rook://open`) opens the chat.
- **Auto-detect frequented places.** `CLVisit` monitoring suggests places you
  spend time at but haven't named; the Places screen lets you promote a
  suggestion into a real geofenced place. Each place shows whether the server
  has a matching `place/<slug>` skill bundle, so a slug mismatch is visible.
- **Settings / capabilities.** The gear opens one screen to set the server
  address, grant Voice (mic + speech), and manage Location — including the
  "Always" upgrade that background geofencing requires.

## Why native (vs. an Expo / React-Native app)

The MVP deliberately leans on iPhone capabilities an Expo app can't match well:

- **Reliable background & terminated-app geofencing** via CoreLocation region
  monitoring (the OS relaunches the app on region entry under Always auth).
  Expo's `expo-location` background geofencing is best-effort and weak on
  terminated-app relaunch.
- **Live Activities / Dynamic Island** via first-class ActivityKit + a Widget
  extension. Expo support is experimental community config-plugins.
- **`CLVisit` "where you spend time" detection** — not surfaced by Expo.
- **On-device Speech + `AVSpeechSynthesizer` with `AVAudioSession` control.**
- **1:1 SwiftUI design reuse** with the Mac app through RookKit, instead of
  re-implementing the design in RN.

Honest counterpoint: Expo can do foreground location, basic push, and a chat UI
fine. The native wins are background/terminated reliability, Live Activity
maturity, latest-API access, design parity, and `CLVisit`.

## Architecture

```text
Rook (iOS app target)                         RookWidgets (app-extension)
  ├─ RookApp.swift        @main App             └─ RookLiveActivity   Dynamic Island / Lock Screen
  ├─ RookModel.swift      chat/session/offer reducer + place + voice + Live Activity
  ├─ Location/
  │   ├─ Place.swift          Place + PlaceStore (UserDefaults) + CLVisit suggestions
  │   └─ LocationProvider.swift   CLCircularRegion monitoring, CLVisit, Always auth
  └─ Views/               RootView · AgentPickerScreen · ChatScreen · PlacesScreen · EnvironmentOfferSheet
            │
            ▼ depends on
        RookKit  ──── Models · Net (RookAPI/AcpSocket) · Design · Voice · LiveActivity
            │
            ▼ REST + ACP JSON-RPC over WebSocket
        Rook server @ 127.0.0.1:3000
```

`RookModel` is the iOS counterpart of the Mac app's `RookMacModel`: it
reuses the same socket/offer/chat reducer and substitutes `LocationProvider`
(place) for `ForegroundAppMonitor` (app). Every macOS-only service (the Mac
bridge, Accessibility/AX, screen capture, hotkeys, server supervision) is
dropped.

### The location → skill loop

Mirrors `RookMacModel.handleForegroundApp`, with place in place of app:

1. You define places → `PlaceStore`; `LocationProvider` monitors their regions
   (Always auth recommended for background entry).
2. **Region enter** (foreground, background, or on relaunch): build
   `place:<slug>`, pre-check skills via `GET /api/environments/preview`. If
   non-empty, `register`; if empty, skip (no empty offer).
3. Server pushes `environment_offer_available` → `EnvironmentOfferSheet` → you
   approve → `POST /api/environments/decision` → skills load into the session.
4. **Region exit**: `markEnvironmentUnavailable`.
5. **Reconnect / relaunch**: re-announce the current place. **Background**:
   released on `scenePhase == .background`.

## Place skill bundles

A place maps to skills iff `environment-repository/place/<slug>/<skill>/SKILL.md`
exists at the repo root — no server code involved. The shipped example:

```
environment-repository/place/office/office-companion/SKILL.md
```

Define a place named "Office" (slug `office`) and entering its geofence offers
that bundle.

## Getting it running

Prerequisites: Xcode, [xcodegen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`), and Node (for the Rook server). The iOS
**Simulator shares the Mac's network**, so the default
`http://127.0.0.1:3000` works unchanged from the simulator.

Fast paths from the repo root:

```zsh
./scripts/run-rook.sh sim
./scripts/run-rook.sh phone
./scripts/run-rook.sh stop   # shut down server + launched app(s)
```

`run-rook.sh sim` starts the server if needed, regenerates the Xcode project from `project.yml`, rebuilds incrementally, installs the fresh app into the selected simulator, and launches it with `ROOK_SERVER_BASE_URL=http://127.0.0.1:3000`.

`run-rook.sh phone` does the same for a paired physical iPhone, requiring the app's server address to use your Mac's Tailscale MagicDNS name (`http://<your-mac>.ts.net:3000`) unless you explicitly override it with `--server-url`. You can also force a specific MagicDNS hostname with `ROOK_TAILSCALE_DNS_NAME`. It intentionally does **not** hardcode a development team into `project.yml`; pass `--team` / `ROOK_IOS_DEVELOPMENT_TEAM` when needed, or let the script auto-detect your local team for personal use.

Manual steps:

```zsh
# 1. Start the Rook server (skip if already running)
cd <path-to-rookery>        # the repo root
npm run dev
# verify: curl http://127.0.0.1:3000/api/health  ->  {"ok":true,...}

# 2. Generate the Xcode project and build for a simulator
cd clients/iphone
xcodegen generate
xcodebuild -project Rook.xcodeproj -scheme Rook \
  -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' build

# 3. Open Rook.xcodeproj in Xcode and Run on a simulator (or boot + install the
#    built .app with simctl). For Live Activity / Dynamic Island, pick an
#    iPhone 14 Pro or newer simulator.
```

For a **physical device**, the launcher script sets the base URL for you at launch time using your Mac's Tailscale MagicDNS hostname. If you run manually, set the base URL to the Tailscale address your phone can reach. The base URL is stored in `UserDefaults` (`RookModel.baseURLString`) and can also be overridden at launch with `ROOK_SERVER_BASE_URL`; the `NSAllowsLocalNetworking` ATS exception in `Info.plist` permits the cleartext connection.

### Onboarding: iPhone client + home server over Tailscale

If you want Rook to live on a computer at home and stay reachable from your
phone anywhere, Tailscale is the simplest setup.

Typical arrangement:

- a spare Mac, Mac mini, or laptop stays on at home and runs the Rook server
- the iPhone runs the Rook client
- both devices are signed into the same Tailscale tailnet
- the iPhone talks to the server using the Mac's MagicDNS hostname

Recommended flow:

1. Create a Tailscale account.
2. Install Tailscale on the Mac that will run the server.
3. Install Tailscale on the iPhone.
4. Sign both devices into the same tailnet.
5. Copy the Mac's MagicDNS hostname from Tailscale (for example,
   `johns-2024-macbook-pro.tail6ee26a.ts.net`).
6. Start the Rook server on the Mac.
7. Launch the iPhone app with `./scripts/run-rook.sh phone`, or manually set the
   server URL in Rook's Settings screen to:
   - `http://<your-mac>.ts.net:3000`

Once this is working, the phone can maintain a direct encrypted connection to
that home machine from anywhere with internet access; the devices no longer
need to share the same local network.

### Troubleshooting Tailscale connectivity on iPhone

If the iPhone app is not connecting, first test the network path outside the
app:

1. On the iPhone, open Safari.
2. Visit:
   - `http://<your-mac>.ts.net:3000/api/health`
3. Expected result:
   - `{"ok":true,"service":"rook"}`

That is the best intermediate test point:

- If Safari **fails**, the issue is probably Tailscale itself: the phone may
  not be connected, may be on the wrong tailnet, MagicDNS may be unavailable,
  or the Mac may not be running the server.
- If Safari **succeeds** but Rook fails, verify the server URL in the app's
  Settings screen exactly matches the working Safari URL, then relaunch or
  reinstall the app so it picks up the current configuration.

### Verifying location → skills on the simulator

1. In the app, add a place (e.g. "Office") at a coordinate of your choice.
2. In the simulator: **Features → Location → Custom Location** (or a GPX route),
   set a coordinate **inside** that geofence → the offer sheet appears → approve.
3. Ask the agent something the office skill covers → it answers using the place
   skill. Move the simulated location away → `unregister` fires.

Test hooks for scripted verification (set as `SIMCTL_CHILD_*` env vars):

- `ROOK_SEED_PLACE="Office,37.33,-122.03,150"` — seed a place on launch.
- `ROOK_SEED_VISIT="37.33,-122.03,4"` — seed a `CLVisit` suggestion.
- `ROOK_SHOW_PLACES=1` — open the Places screen on launch.

### Minimizing / backgrounding in the simulator

iOS apps can't background themselves, so to exercise the app-lifecycle paths
(socket reconnect, place re-announce, Live Activity start-on-foreground), use
Simulator's **Device → Home** (⇧⌘H) gesture to send Rook to the background, then
reopen it from the simulator home screen.

If you want shell equivalents:

```zsh
xcrun simctl openurl booted https://example.com   # foreground Safari, backgrounds Rook
xcrun simctl launch booted com.rookery.Rook       # bring Rook back
xcrun simctl io booted screenshot /tmp/rook.png   # screenshot the simulator
```

## Capabilities & Info.plist

- **Background Modes → Location updates** (`UIBackgroundModes: location`).
- Usage strings: `NSLocationWhenInUseUsageDescription`,
  `NSLocationAlwaysAndWhenInUseUsageDescription` (Always is required for
  background region relaunch), `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription`.
- `NSSupportsLiveActivities = YES`.
- `NSAppTransportSecurity → NSAllowsLocalNetworking = YES` for the localhost/LAN
  dev server.
- `NSAppTransportSecurity → NSExceptionDomains → tail6ee26a.ts.net` allows
  insecure HTTP/WebSocket loads to your Tailscale MagicDNS hostnames during
  development.

## Out of scope (follow-ups)

The MVP targets the local Mac dev server, unauthenticated, on the LAN. True
away-from-home presence (push-to-start Live Activities and remote updates while
the app is closed) needs a hosted server + APNs + Sign in with Apple — see
[`PRODUCT_CHANGES/research/rook-on-iphone.md`](../../PRODUCT_CHANGES/research/rook-on-iphone.md)
Phase 3. `Sources/Rook.entitlements` carries the `aps-environment` entitlement as
scaffolding for that device/push work; it is inert on the unsigned simulator
build and does nothing without the server-side push pipeline.
