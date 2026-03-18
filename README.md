# Green Screen React

Multi-protocol legacy terminal emulator for React. Connects to **TN5250** (IBM i / AS/400), **TN3270** (z/OS mainframe), **VT220** (OpenVMS, Unix), and **HP 6530** (NonStop) hosts.

[**Live Preview**](https://visionbridge-solutions.github.io/green-screen-react/)

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
npx green-screen
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
  react/     → green-screen-react  (npm)   React component
  proxy/     → green-screen-proxy  (npm)   WebSocket-to-TCP proxy
  types/     → green-screen-types          Shared type definitions
apps/
  demo/      Example Vite app
  worker/    Cloudflare Worker deployment
```

## Features

- **Multi-protocol** — TN5250, TN3270, VT220, HP 6530
- **Real-time WebSocket** — instant screen updates
- Protocol-specific colors and screen dimensions
- Keyboard input: text, function keys (F1–F24), tab, arrows
- Field-aware rendering with input underlines
- Typing animation with correction detection
- Auto-reconnect with exponential backoff
- Themeable via CSS custom properties
- Inline sign-in form (host, credentials, protocol picker)
- Pluggable adapter interface
- Mock mode for evaluation without a real host
- Zero runtime dependencies (peer dep: React 18+)

## License

MIT
