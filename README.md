# Green Screen React

Legacy terminal emulator for React. Supports **TN5250** (IBM i / AS/400). TN3270, VT220, and HP 6530 are accepted as protocol parameters but have not been properly tested yet.

[![Live Preview](apps/demo/preview.gif)](https://visionbridge-solutions.github.io/green-screen-react/)

## Getting Started

```bash
git clone https://github.com/visionbridge-solutions/green-screen-react.git
cd green-screen-react
npm install
npm run dev
```

Opens the demo app at `http://localhost:5173/green-screen-react/` with the proxy on port 3001 by default.

## Standalone Use

Run a web-based terminal without cloning the repo:

```bash
npx green-screen-terminal
```

Opens a browser-based terminal on `http://localhost:3001`. Use the sign-in form to connect to any supported host.

## Use in Your Project

```bash
npm install green-screen-react green-screen-proxy
```

See [green-screen-react](https://www.npmjs.com/package/green-screen-react) and [green-screen-proxy](https://www.npmjs.com/package/green-screen-proxy) on npm for integration docs.

## How It Works

Browsers can't open raw TCP sockets. The proxy bridges WebSocket to TCP:

```
  React App               Proxy                    Host
┌────────────┐        ┌────────────┐        ┌────────────┐
│ <GreenScreen│  WS    │  Node.js   │  TCP   │  IBM i     │
│  Terminal/> │◄──────►│  :3001     │◄──────►│  Mainframe │
└────────────┘        └────────────┘        └────────────┘
```

## Project Structure

```
packages/
  react/       → green-screen-react      (npm)   React component
  proxy/       → green-screen-proxy      (npm)   WebSocket-to-TCP proxy
  standalone/  → green-screen-terminal   (npm)   Standalone CLI
  types/       → green-screen-types               Shared type definitions
  client-py/   → green-screen-client     (PyPI)  Python async client
                                                 (ships independently)
apps/
  demo/      Example Vite app
  worker/    Cloudflare Worker deployment
```

## Features

- **TN5250** — tested and supported (IBM i / AS/400)
- **TN3270, VT220, HP 6530** — accepted as parameters but not thoroughly tested
- **Real-time WebSocket** — instant screen updates
- Protocol-specific colors and screen dimensions
- Keyboard input: text, function keys (F1–F24), tab, arrows
- Field-aware rendering with input underlines
- Typing animation with correction detection
- Auto-reconnect with exponential backoff
- Themeable via CSS custom properties
- Inline sign-in form (host, credentials, protocol picker)
- Pluggable adapter interface
- Zero runtime dependencies (peer dep: React 18+)

## What's New in v1.2.0

- **Per-field MDT state on the wire** — `Field.modified` and a new `FieldValue` type let integrators do cheap post-write verification without diffing the entire screen.
- **`/read-mdt` primitive** — REST `GET /read-mdt` and WS `readMdt` command return just the input fields whose modified-data-tag bit is set. Exposed on both `RestAdapter` and `WebSocketAdapter` as `readMdt()`.
- **Pluggable session store** — implement `SessionStore` and call `setSessionStore()` before the proxy starts accepting traffic. Default is the built-in `InMemorySessionStore`.
- **Session resumption** — REST `POST /session/resume`, WS `reattach`, plus `session.lost` / `session.resumed` lifecycle events (`WebSocketAdapter.onSessionLost()` / `onSessionResumed()` on the client).
- **Lower-level sign-on primitives** — `markAuthenticated(username)` and `waitForScreenWithFields(min, timeoutMs)` so integrators can build robust sign-on cascades without the proxy growing host-specific logic.
- **`green-screen-client`** — new standalone Python package (`packages/client-py/`) that mirrors the adapter contract for async Python clients. Ships separately on PyPI.

## License

MIT
