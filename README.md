# Cursor Local Remote

Control Cursor from your phone, tablet or any browser on your local network. Great for monitoring and nudging Cursor while in the bathroom, watching a movie or cooking food.

A local web UI that talks to Cursor's CLI agent on your machine. No cloud, accounts or other bs just on your local network. Also added some rudamentary security so that you need a key to access it incase you have many in a Wifi network. Important to only use this on trusted network that are safe, because the security is easy to bruteforce if you are in the same network.

## Demo
https://github.com/user-attachments/assets/6b2284fd-0e3d-46c9-ae63-86bbd672ad72



## Good to know

This is essentially an easy way to use the Cursor CLI from your phone or any other device on your network.

You can **start new sessions** from the remote UI and they work fully: the agent runs, edits files, executes commands, everything. However, sessions started remotely won't appear in Cursor's desktop sidebar. This is a Cursor limitation, it stores conversation state in an internal in-memory store that can't be written from outside the process.

The remote UI can see **all** sessions, both ones started in the IDE and ones started remotely. You can monitor active desktop sessions in real time, browse and resume past sessions, or start fresh ones. Messages sent from the remote won't show up in the IDE's chat view, but the work the agent does (file edits, commands) happens on your machine either way.

## Install

```bash
npm install -g cursor-local-remote
```

Then start it:

```bash
clr
```

A QR code pops up in your terminal — scan it from your phone and you're connected.

## Features

- **Send prompts** to Cursor's agent from any device on your network
- **Watch responses stream in** — text, tool calls, file edits, shell commands
- **Pick a model** — fetches your available models from Cursor
- **Switch modes** — Agent, Ask, or Plan
- **Browse sessions** — see all past Cursor sessions for the workspace
- **Live tail** — watch an active desktop session update in real time
- **Resume sessions** — continue any past session from the web UI
- **Stop / retry / copy** — cancel a running response, retry, or copy any message
- **Install as app** — PWA support, add to home screen on iOS/Android for a native feel
- **Push notifications** — get notified when the agent finishes while the tab is in the background
- **Settings** — toggle workspace trust, notifications, and sound from the UI
- **Haptic feedback** — tactile feedback on mobile devices
- **Sound effects** — audio cues on completion and errors
- **Multi-tab sessions** — work with multiple chat sessions side by side
- **Share via QR** — in-app QR code to quickly connect another device
- **Auto-port** — if the default port is busy, the CLI finds the next available one

## Usage

`clr` is the short alias for `cursor-local-remote`.

```
clr [workspace] [options]
```

| Option | Description |
| --- | --- |
| `workspace` | Path to your project folder (defaults to cwd) |
| `-p, --port` | Port to run on (default: `3100`) |
| `--no-open` | Don't auto-open the browser |
| `--no-qr` | Don't show QR code in terminal |
| `--no-trust` | Disable workspace trust (agent will ask before actions) |
| `-v, --verbose` | Show all server and agent output |

```bash
clr                          # current folder
clr ~/projects/my-app        # specific project
clr --port 8080              # different port
clr --no-open --no-qr        # headless-friendly
```

## How it works

```
Phone / tablet / browser  ── LAN ──>  Next.js (0.0.0.0:3100)  ──>  cursor CLI (agent)
                          <─ stream ─
```

The CLI starts a pre-built Next.js server on your machine. When you send a prompt, the server spawns a headless `agent` process (`agent -p <prompt> --output-format stream-json`) and streams the NDJSON output back to the browser over HTTP. Session history comes from reading Cursor's own transcript files in `~/.cursor/projects/`, so you see all sessions, not just ones started from this tool.

### Authentication

Every launch generates a memorable word-pair token (e.g. `alpine-berry`) printed in the terminal. You can set a fixed token via the `AUTH_TOKEN` env var. Access is granted by:

1. Scanning the QR code (encodes the network URL with the token)
2. Visiting the URL with `?token=<token>` (sets an `httpOnly` cookie for 7 days)
3. Passing `Authorization: Bearer <token>` for API calls

### API

All endpoints require a valid token (cookie or `Bearer` header).

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/chat` | `POST` | Send a prompt. Returns an NDJSON stream of agent events. Body: `{ prompt, sessionId?, model?, mode? }` |
| `/api/models` | `GET` | List available models from `agent models` (cached 5 min) |
| `/api/sessions` | `GET` | Session list (merged Cursor + CLR sessions). `?all=true` for all workspaces |
| `/api/sessions` | `DELETE` | Delete a stored session. Body: `{ sessionId }` |
| `/api/sessions/active` | `GET` | List currently running agent session IDs |
| `/api/sessions/active` | `DELETE` | Kill a running agent process. Body: `{ sessionId }` |
| `/api/sessions/history` | `GET` | Full transcript for a session. `?id=<sessionId>` |
| `/api/sessions/watch` | `GET` | SSE stream for live session updates. `?id=<sessionId>` |
| `/api/settings` | `GET` | Get current settings (trust, notifications, sound) |
| `/api/settings` | `PATCH` | Update settings. Body: `{ trust?, notifications?, sound? }` (booleans) |
| `/api/info` | `GET` | Network info, auth URL, and workspace path |
| `/api/push/vapid-key` | `GET` | VAPID public key for push notification subscription |
| `/api/push/subscribe` | `POST` | Register a push subscription. Body: standard `PushSubscription` JSON |
| `/api/push/subscribe` | `DELETE` | Remove a push subscription. Body: `{ endpoint }` |

### Environment variables

| Variable | Description |
| --- | --- |
| `AUTH_TOKEN` | Fixed auth token (otherwise randomly generated each launch) |
| `CURSOR_WORKSPACE` | Workspace path (set automatically by the CLI) |
| `CURSOR_TRUST` | Set to `1` to pass `--trust` to the agent (auto-approve all tool calls) |
| `PORT` | Server port (default: `3100`) |

## Requirements

- [Node.js](https://nodejs.org/) 20+
- [Cursor](https://cursor.com) with the CLI installed (`agent --version` should work)
- A Cursor subscription (Pro, Team, etc.)

## Development

Contributions are welcome. Mainly created this so that I can use cursor when I don't feel like being at my desk. Whole project vibecoded with cursor, obviously.

```bash
git clone https://github.com/jon-makinen/cursor-local-remote.git
cd cursor-local-remote
npm install
npm run dev
```

## License

MIT
