# Setup

This page covers first-run setup, local-vs-remote server binding, and the small `.env` knobs used by the repo.

## Quick start

1. Install **pi.dev / Pi** and make sure `pi` is on your `PATH`.
2. Make sure the sibling agent package exists at `../my-agent/` if you plan to use the default Pi profile.
3. Copy `.env.example` to `.env`.
4. Install server deps:
   ```bash
   cd server && npm install
   ```
5. Start Rook from the repo root:
   ```bash
   ./scripts/run-rook.sh mac server
   ```
   or:
   ```bash
   npm run dev
   ```

## How binding works now

Rook now always listens on:

- `127.0.0.1`

That keeps the local Mac client working.

If you also set `ROOK_BIND_IP`, Rook adds a **second** listener on that address.
That is the right setup when you want:

- the Mac app to talk to Rook over localhost
- the iPhone to talk to Rook over your VPN or other private remote network

## `.env` variables

Rook reads `.env` from the repo root.

### `PORT`
Server port. Default:

```env
PORT=3000
```

### `ROOK_BIND_IP`
Optional second listener for remote phone access.

Example:

```env
ROOK_BIND_IP=100.x.y.z
```

Important: this should be the **full local IP address assigned to your Mac on that remote network interface**.

It is **not**:
- a subnet
- a CIDR block
- a partial IP
- “any device in the VPN”

Binding is about **which address on your own machine the server listens on**.

Other devices on the VPN can reach that listener because the VPN routes traffic to your Mac's bound address.

### `ROOK_REMOTE_HOSTNAME`
Optional helper for the phone launcher.

```env
ROOK_REMOTE_HOSTNAME=your-computer.example.net
```

If set, `./scripts/run-rook.sh phone` uses this hostname automatically.

Use this when:
- your phone should connect by hostname rather than raw IP
- your VPN gives you a stable hostname
- you prefer a DNS name over a numeric address

If you do not set `ROOK_REMOTE_HOSTNAME`, the phone launcher next tries `ROOK_BIND_IP`.
If neither is set, it stops and tells you what to configure.

### `ROOK_AUTH_TOKEN`
Optional bearer token for all client access.

Example:

```env
ROOK_AUTH_TOKEN=replace-with-a-long-random-string
```

Current behavior:
- if unset, Rook has no app-level auth
- if set, **every** HTTP and WebSocket request must send `Authorization: Bearer <token>`
- that includes localhost clients, the Mac app, the iPhone app, and debug scripts

This closes the browser/localhost gap where a hostile local webpage or process could otherwise talk to Rook without authenticating.

## Common setups

### Local-only Mac development

```env
PORT=3000
ROOK_AUTH_TOKEN=
```

No remote phone access.

### Mac + iPhone over a private remote network

```env
PORT=3000
ROOK_BIND_IP=100.x.y.z
ROOK_AUTH_TOKEN=replace-with-a-long-random-string
```

Then launch with:

```bash
./scripts/run-rook.sh mac phone
```

The launcher passes the server URL and auth token through to the iPhone app. Keep the phone unlocked while the script installs and opens the app; otherwise iOS will deny the launch request.

### Mac + iPhone with hostname-based remote access

```env
PORT=3000
ROOK_BIND_IP=100.x.y.z
ROOK_REMOTE_HOSTNAME=your-hostname.example.net
ROOK_AUTH_TOKEN=replace-with-a-long-random-string
```

The Mac app still uses localhost, but now sends the bearer token too.
The iPhone launcher uses `ROOK_REMOTE_HOSTNAME`.

## Remote access notes

For remote phone access you typically need:
- the Mac and iPhone connected through the same private remote network or VPN
- `ROOK_BIND_IP` set to the Mac's address on that network
- the iPhone pointed at either that IP or a hostname that resolves to it

A simple option is Tailscale. Briefly:
- install it on the Mac and iPhone
- sign both devices into the same network
- find the Mac's VPN IP or hostname
- put the IP into `ROOK_BIND_IP`
- put the hostname into `ROOK_REMOTE_HOSTNAME`

For iPhone development over plain HTTP, ATS can still be picky. In practice, prefer the hostname form (for example `...ts.net`) over a raw IP address.

## iPhone developer trust

On a physical iPhone, a freshly installed local dev build will often fail to open until you trust the developer certificate on the device.

If iOS shows **Untrusted Developer**, go to:

- **Settings**
- **General**
- **VPN & Device Management**
- select your **Apple Development** identity
- tap **Trust**

Then relaunch the app.

This is a normal part of running unsigned/local development builds on iPhone.

## Security model, tersely

- `127.0.0.1` means only the local machine can connect directly.
- `ROOK_BIND_IP` adds one additional remote listener on your Mac.
- it does **not** expose every interface the way `0.0.0.0` does.
- `ROOK_AUTH_TOKEN` adds a second layer for remote access.

For agent-profile config, see [Configuration](./configuration.md).
