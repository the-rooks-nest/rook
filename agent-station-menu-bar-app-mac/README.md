# Agent Station Menu Bar (macOS)

A native SwiftUI menu bar client for [Agent Station](../README.md) — talk to
your Pi / Claude / Cursor agents from the macOS menu bar. The panel layout and
interaction model (slide-in detail views, hover affordances) follow the Stoa
Scribe menu bar app; the visual design tokens are lifted from the Agent
Station web client (`agent-server-client/src/client/styles/tokens.css`) so the
two clients share one look. Functionality is the full Agent Station embeddable
client, implemented natively against the server's REST + ACP JSON-RPC
WebSocket protocol.

## Features

- **Agent picker** — `GET /api/agents`, rendered as a tree (profiles indented
  under their parent agent).
- **Sessions** — per-agent session history with running/stopped state, resume
  any session, or start a named new chat (`POST /api/agent/start`).
- **Auto-resume** — on launch the app rejoins the most recent session
  (`GET /api/agent/session/recent`), like the web client.
- **Streaming chat** — `session/prompt` over `ws://127.0.0.1:3000/api/ws`;
  renders agent text, thinking (collapsible), tool calls with live
  input/output, plans, run errors, and context usage.
- **Message queueing** — messages sent while the agent is busy queue and
  auto-send after the current turn (120 ms gap), matching the web client.
- **Environment offers** — `environment_offer_available` events open a native
  approval view with skill-file preview (`GET /api/environments/preview`) and
  the four 2×2 decisions (`POST /api/environments/decision`): allow this
  visit / always allow / not now / never.
- **Server supervision** — health polling; if the server is down the panel can
  launch `npm run dev` for the repo and tail its log
  (`~/Library/Logs/AgentStationMenuBar/server.log`).
- **Foreground-app environment provider** — the app is a third environment
  provider alongside the Chrome extension and Obsidian plugin: it watches
  which Mac app is frontmost (NSWorkspace activation notifications — no
  Accessibility permission needed) and registers/unregisters `app:<slug>`
  environments as you switch apps.

## Voice (hands-free)

Talk to your agent and hear it reply, without the input box. The loop runs
locally in the menu bar app and reuses the existing agent websocket:

1. **Speech → text** — Apple Speech (`SFSpeechRecognizer`), on-device on Apple
   Silicon. Press-to-talk; a ~1.4 s pause ends your turn.
2. The transcript is sent to the current session like any typed message.
3. **Text → speech** — `AVSpeechSynthesizer` speaks the streamed reply
   sentence-by-sentence (markdown/code stripped) as it arrives.

Enable it on the **Voice** card, then **press to talk** there or hit
**⌃⌥Space from any app** (global hotkey; uses the Accessibility grant). First
use prompts for Microphone + Speech Recognition. Combined with Computer
Control, you can speak a request and have the agent act on your screen and
report back aloud — no typing.

**Timing.** Your speech is sent as the prompt; the agent's reply is spoken
**once, after the full turn completes and renders** — not streamed
sentence-by-sentence. Thinking and tool steps are silent; only the final
response is read.

**Stopping it.** A **Stop** button appears on the Voice card while it's
speaking. Pressing to talk (or ⌃⌥Space) also interrupts playback — barge-in —
so you can cut it off and respond.

**Better voice.** The app auto-selects the best installed English voice
(premium → enhanced → default). macOS ships only low-quality voices by default
(you'll get "Samantha"), so for a natural voice download a **Premium** one:
System Settings → Accessibility → Spoken Content → System Voice → *Manage
Voices…* → English → pick a *(Premium)* or Siri voice. The app uses it
automatically; pin a specific one with `defaults write
com.rookery.AgentStationMenuBar VoiceIdentifier <voice-id>`. For studio-quality
voices, swap `VoiceController`'s synthesizer for a cloud TTS (ElevenLabs,
Cartesia, OpenAI).

This is the local-first tier (free, private, no API). The quality knobs are
swappable without touching the agent: drop in a cloud STT (Deepgram, Whisper)
or a natural TTS (ElevenLabs, Cartesia) behind `VoiceController`, or front the
whole thing with a realtime speech-to-speech model (OpenAI Realtime, Gemini
Live) as an I/O layer that forwards to Agent Station as the brain.

## Foreground-app environments

The on-disk repository is the registry: a foreground app maps to environment
`app:<slug>` iff `environment-repository/app/<slug>/` exists at the repo root.
Directory names are matched against the slugified app name ("Visual Studio
Code" → `visual-studio-code`) and the app's bundle id (full, or its last
component). To make a new app contextual, just add a skill bundle:

```
environment-repository/app/cursor/cursor-companion/SKILL.md
```

Switching to that app registers the environment (`POST
/api/environments/register`); switching away ends the episode (`POST
/api/environments/unavailable`), so "Allow this visit" naturally means "while
this app stays in the foreground area of my work". Activations are debounced
(700 ms) so ⌘-Tab flicker doesn't churn registrations, the app ignores its own
activations (opening the panel doesn't end the episode), and the current
environment is re-announced if the server restarts. Offers arrive over the
session websocket like any other environment — the menu bar bird fills amber
and the native approval view shows the skill files before anything loads.

Provider activity is traced to `/tmp/agent-station-menubar.log` for debugging.

### Tier 1 — window-title perception

App *identity* is free (NSWorkspace), but reading inside another app — its
focused **window title** — needs the macOS **Accessibility** permission. Grant
it from the **Context Bridge** card in the panel (or System Settings → Privacy
& Security → Accessibility). Once granted, the title is included in
registration metadata and in the live bridge context. Window titles are
surprisingly rich: Slack's is `#channel (Workspace) - Slack`, a browser's is
the tab title, most editors show the document name. Title changes *within* an
app (switching Slack channels) are picked up by a 2 s poll and pushed to the
bridge without re-registering.

> Unsigned/ad-hoc dev builds can lose the Accessibility grant on each rebuild
> because TCC keys on code identity. Re-grant after a rebuild, or sign the app
> with a stable identity.

### Tier 2 — the Mac bridge

The app runs a loopback HTTP server (default `http://127.0.0.1:8765`, override
with `defaults write com.rookery.AgentStationMenuBar MacBridgePort <n>`) that
the agent's shell tool can `curl` to perceive and drive the Mac:

| Route | Body | Returns |
|-------|------|---------|
| `GET /context` | — | `{ frontmostApp, bundleId, windowTitle, environmentId, accessibilityTrusted }` |
| `GET /health` | — | `{ ok, service }` |
| `POST /applescript` | `{ "script": "…" }` | `{ ok, output }` |
| `POST /open-url` | `{ "url": "…" }` | `{ ok }` |

No server-side change was needed: Pi/Claude agents already have a shell tool,
so an app's skill bundle simply documents these endpoints and the agent calls
them. `POST /applescript` targeting another app triggers a one-time macOS
Automation consent prompt (declared via `NSAppleEventsUsageDescription`).
Centralizing these grants in one user-visible app is the point — Accessibility,
Automation, and Screen Recording are approved once here instead of being
attributed to the node server's subprocesses.

### Tier 4 — computer use (perception + control)

For driving apps the way a person does. Two grounding strategies share one set
of primitives:

| Route | Body | Returns | Gate |
|-------|------|---------|------|
| `GET /ax-elements` | — | `{ ok, elements: [{ id, role, label, x, y, width, height, centerX, centerY }] }` | Accessibility |
| `GET /screenshot` | — | `{ ok, png_base64, pixelWidth, pixelHeight, originX, originY, scale }` | Screen Recording |
| `POST /input` | `{ action, … }` | `{ ok, output }` | **Computer Control toggle** + Accessibility |

`/input` actions (coordinates are global top-left screen space, matching
`/ax-elements` frames): `move`/`click`/`doubleClick` `{x,y}`, `type` `{text}`,
`key` `{key, modifiers?}` (e.g. `{"key":"return","modifiers":["cmd"]}`).

Two paths, by app:

- **AX-driven control** (native apps, text-only models like DeepSeek V4 Pro):
  read `/ax-elements`, pick one by `id`, `POST /input {action:"click", x:centerX,
  y:centerY}`. No screenshot or vision model needed — the model reasons over the
  element list as text.
- **Pixel-vision control** (opaque apps with no useful AX tree, e.g. CapCut):
  `GET /screenshot`, send the image to a vision-grounding model (e.g. DeepSeek
  V4 Vision), map its chosen pixel back to screen coords via the returned
  `originX/originY/scale`, then `POST /input`. *Sending the screenshot into the
  model's context requires image content blocks in the ACP layer (the server
  protocol is currently text-only); that's the remaining server-side change for
  this path.*

**Safety.** `/input` is gated behind an explicit **Computer Control** toggle in
the panel, off by default and persisted (`EnableComputerControl`). Input
coordinates are clamped to the union of screen frames. The agent already has
shell access (so it could `osascript`/`cliclick` regardless), but routing
control through this one toggle gives a single, visible kill switch. Turn it off
when you're not actively supervising.

The shipped `environment-repository/app/slack/` bundle is a worked example:
focusing Slack offers a skill that reads `/context` to learn the current
channel and uses `slack://` deep links + AppleScript through the bridge to
navigate and draft messages.

## Getting it running — exact steps

Prerequisites: Xcode, [xcodegen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`), and Node (for the Agent Station server).

```zsh
# 1. Start the Agent Station server (skip if it's already running)
cd <path-to-rookery>   # the repo root
npm run dev
# verify: curl http://127.0.0.1:3000/api/health  ->  {"ok":true,...}

# 2. Generate the Xcode project and build the app
cd agent-station-menu-bar-app-mac
xcodegen generate
xcodebuild -project AgentStationMenuBar.xcodeproj \
  -scheme AgentStationMenuBar -configuration Debug build

# 3. Launch it
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData \
  -path '*/Build/Products/Debug/AgentStationMenuBar.app' -print -quit)
open "$APP_PATH"
```

Look for the **bird icon** in the menu bar (no Dock icon — it's an
`LSUIElement` app). The icon fills and turns amber when an environment offer
is pending, and tints violet while a run is in flight. If you don't see it,
read the troubleshooting section below — on a crowded menu bar this is
expected, not a bug.

To kill and relaunch (e.g. after a rebuild):

```zsh
pkill -f AgentStationMenuBar; sleep 1; open "$(find \
  ~/Library/Developer/Xcode/DerivedData \
  -path '*/Build/Products/Debug/AgentStationMenuBar.app' -print -quit)"
```

The repo root (used by the panel's Start Server button) is derived from this
package's source location; override it with:

```zsh
defaults write com.rookery.AgentStationMenuBar RookeryRepoRoot /path/to/rookery
```

## Troubleshooting: the icon isn't in the menu bar

On notch Macs, macOS silently hides status items that don't fit — there is no
overflow indicator; they just vanish. Worse, each item's position is
*persisted* (distance from the right screen edge) in the app's defaults, so if
the app's first launch lands it in the hidden zone, it stays hidden on every
relaunch. Diagnose and fix:

```zsh
# Is a position stored, and where? (~870+ on a 1512pt display = hidden zone)
defaults read com.rookery.AgentStationMenuBar "NSStatusItem Preferred Position Item-0"

# Fix: quit the app, then pin the item into the visible right-hand cluster
pkill -f AgentStationMenuBar
defaults write com.rookery.AgentStationMenuBar \
  "NSStatusItem Preferred Position Item-0" -float 400
open "$APP_PATH"
```

Once visible you can ⌘-drag the icon and macOS persists wherever you drop it.
Long-term, a menu bar manager (e.g. Ice: `brew install --cask
jordanbaird-ice`, or Bartender) avoids the overflow cull entirely.

**Window-mode escape hatch** — run the panel as a regular floating window
(works regardless of menu bar space; re-running `open` on the app brings the
window back after closing it):

```zsh
defaults write com.rookery.AgentStationMenuBar ShowPanelWindow -bool true   # on
defaults write com.rookery.AgentStationMenuBar ShowPanelWindow -bool false  # off
```

## Notes on the wire protocol

- The websocket carries pure ACP JSON-RPC frames; the app sends only
  `session/prompt` and treats the JSON-RPC response as end-of-turn.
- Duplicated server-synthesized updates (`user_message_chunk` echoes,
  `_rookery_run_*`, `_rookery_status_changed`) are intentionally ignored,
  mirroring the React client's dedupe strategy.
- The server replays no message history; resuming a session starts with an
  empty thread (the app notes this inline).
- Rooms idle-stop ~15 s after their last client disconnects. The app keeps its
  socket open while a session is current — including while the panel is
  closed — and transparently restarts the room (re-`POST /api/agent/start`)
  when reconnecting.
- Intentional socket teardowns (switching sessions) are silent; only genuine
  transport failures trigger the reconnect path, and a successful connection
  cancels any armed reconnect.
