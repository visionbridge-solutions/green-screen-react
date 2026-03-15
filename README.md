# GREEN SCREEN REACT (EMULATOR FOR WEB)

Multi-protocol legacy terminal emulator for React. Connects to **TN5250** (IBM i / AS/400), **TN3270** (z/OS mainframe), **VT220** (OpenVMS, Unix), and **HP 6530** (NonStop) hosts.

[**Preview**](https://visionbridge-solutions.github.io/green-screen-react/)

## Features

- **Multi-protocol** — TN5250, TN3270, VT220, HP 6530
- **Real-time WebSocket** — instant screen updates
- Protocol-specific color conventions and screen dimensions
- Keyboard input: text, function keys (F1-F24), tab, arrow keys
- Field-aware rendering with input field underlines
- Typing animation with correction detection
- Auto-reconnect with exponential backoff
- Fully themeable via CSS custom properties
- Zero runtime dependencies (peer deps: React 18+)
- Togglable inline sign-in form (host, credentials, protocol picker)
- Pluggable adapter interface for any backend
- Mock mode for instant evaluation without a real host

## How It Works

Browsers cannot open raw TCP sockets to telnet hosts. You need a backend that bridges WebSocket to TCP. Choose one:

**Option A — Run locally (development):**
```
  Your React App          green-screen-proxy           Legacy Host
┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
│  <GreenScreen│  WS    │   Node.js proxy  │  TCP   │  IBM i       │
│   Terminal/> │◄──────►│   localhost:3001  │◄──────►│  Mainframe   │
│              │        │                  │        │  VMS / etc.  │
└──────────────┘        └──────────────────┘        └──────────────┘
  npm install             npx green-screen-proxy
  green-screen-react
```

**Option B — Deploy to Cloudflare (production):**
```
  Your React App          Cloudflare Worker            Legacy Host
┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
│  <GreenScreen│  WS    │  Durable Object  │  TCP   │  IBM i       │
│   Terminal/> │◄──────►│  holds TCP conn  │◄──────►│  Mainframe   │
│              │        │                  │        │  VMS / etc.  │
└──────────────┘        └──────────────────┘        └──────────────┘
  npm install             npx green-screen-proxy deploy
  green-screen-react
```

| | Node.js Proxy | Cloudflare Worker |
|---|---|---|
| Run with | `npx green-screen-proxy` | `npx green-screen-proxy deploy` |
| Transport | WebSocket (real-time) | WebSocket (real-time) |
| Best for | Local dev, self-hosted infra | Production, static sites |
| Cost | Free (your server) | Free (Cloudflare free tier) |

Both use the same WebSocket protocol, so `WebSocketAdapter` works with either.

## Quick Start

**Step 1 — Install the component:**

```bash
npm install green-screen-react
```

**Step 2 — Start the proxy** (in a separate terminal):

```bash
npx green-screen-proxy --mock
```

This starts the proxy on `http://localhost:3001` with mock screens — no real host needed to try it out.

**Step 3 — Render the terminal:**

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

function App() {
  return <GreenScreenTerminal />;
}
```

That's it — the component connects to `localhost:3001` automatically. Remove `--mock` and use the inline sign-in form to connect to a real host.

## Production Deployment (Cloudflare Worker)

Deploy a serverless backend with one command — no server to manage:

```bash
npx green-screen-proxy deploy
```

This will:
1. Install Wrangler (Cloudflare CLI) if not present
2. Log you in to Cloudflare if needed
3. Deploy the worker and print the URL
4. Save the URL to `.env.local` (auto-detects Vite, Next.js, CRA)

Then use it in your app:

```tsx
import { GreenScreenTerminal, WebSocketAdapter } from 'green-screen-react';
import 'green-screen-react/styles.css';

// Reads from VITE_GREEN_SCREEN_URL / NEXT_PUBLIC_GREEN_SCREEN_URL / REACT_APP_GREEN_SCREEN_URL
const adapter = new WebSocketAdapter({
  workerUrl: import.meta.env.VITE_GREEN_SCREEN_URL
});

<GreenScreenTerminal adapter={adapter} />
```

If no `workerUrl` is provided, the adapter defaults to `http://localhost:3001` (the local proxy).

### Deploy options

```bash
npx green-screen-proxy deploy                          # Default settings
npx green-screen-proxy deploy --name my-terminal       # Custom worker name
npx green-screen-proxy deploy --origins https://myapp.com  # Lock CORS to your domain
```

User-deployed workers have no restrictions. The shared demo worker (GitHub Pages) has rate limiting and SSRF protection.

## Proxy Server

The Node.js proxy is ideal for local development and self-hosted environments.

```bash
npx green-screen-proxy              # Start on port 3001
npx green-screen-proxy --mock       # Mock mode (no real host needed)
npx green-screen-proxy --port 8080  # Custom port
PORT=8080 npx green-screen-proxy    # Port via environment variable
```

If you prefer to install it:

```bash
npm install -g green-screen-proxy
green-screen-proxy
```

### Connecting to a real host

Without `--mock`, the proxy opens real TCP connections. The sign-in form in the terminal collects host, port, protocol, and credentials — the proxy handles the rest.

Example: connecting to the public IBM i system at `pub400.com`:

```tsx
<GreenScreenTerminal defaultProtocol="tn5250" />
```

Enter `pub400.com` as the host in the sign-in form. The component connects to the local proxy automatically.

## Adapters

### WebSocketAdapter (recommended)

Real-time bidirectional WebSocket. Works with both the Node.js proxy and the Cloudflare Worker.

```tsx
import { WebSocketAdapter } from 'green-screen-react';

// Local proxy
const adapter = new WebSocketAdapter({ workerUrl: 'http://localhost:3001' });

// Cloudflare Worker
const adapter = new WebSocketAdapter({
  workerUrl: 'https://green-screen-worker.your-subdomain.workers.dev'
});
```

Screen updates are pushed instantly — no polling delay.

### RestAdapter (HTTP polling)

For backends that expose a REST API:

```tsx
import { RestAdapter } from 'green-screen-react';

const adapter = new RestAdapter({
  baseUrl: 'https://your-server.com/api/terminal',
  headers: { Authorization: 'Bearer your-token' },
});
```

Maps adapter methods to HTTP endpoints (relative to `baseUrl`):

| Method | Path | Request Body |
|--------|------|-------------|
| GET | `/screen` | - |
| GET | `/status` | - |
| POST | `/connect` | `{ host, port, protocol }` |
| POST | `/send-text` | `{ text }` |
| POST | `/send-key` | `{ key }` |
| POST | `/disconnect` | - |
| POST | `/reconnect` | - |

### Custom Adapters

Implement `TerminalAdapter` to connect to any backend:

```typescript
import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult, ConnectConfig } from 'green-screen-react';

class MyAdapter implements TerminalAdapter {
  async getScreen(): Promise<ScreenData | null> { /* ... */ }
  async getStatus(): Promise<ConnectionStatus> { /* ... */ }
  async sendText(text: string): Promise<SendResult> { /* ... */ }
  async sendKey(key: string): Promise<SendResult> { /* ... */ }
  async connect(config?: ConnectConfig): Promise<SendResult> { /* ... */ }
  async disconnect(): Promise<SendResult> { /* ... */ }
  async reconnect(): Promise<SendResult> { /* ... */ }
}
```

## Component Usage

### Minimal (inline sign-in)

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

// Connects to localhost:3001 by default. Sign-in form collects host and credentials.
<GreenScreenTerminal />
```

### Switching protocols

```tsx
<GreenScreenTerminal adapter={adapter} protocol="tn3270" />
<GreenScreenTerminal adapter={adapter} protocol="vt" />
<GreenScreenTerminal adapter={adapter} protocol="hp6530" />
```

### Inline Sign-In

The sign-in form appears by default when disconnected. It collects host, port, protocol, and credentials.

```tsx
// Disable the form (use when you manage connections yourself)
<GreenScreenTerminal adapter={adapter} inlineSignIn={false} />

// Pre-select a protocol
<GreenScreenTerminal
  adapter={adapter}
  defaultProtocol="tn3270"
  onSignIn={(config) => console.log('Connecting to', config.host)}
/>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `adapter` | `TerminalAdapter` | - | Backend communication adapter |
| `baseUrl` | `string` | - | Shorthand — auto-creates a RestAdapter |
| `protocol` | `'tn5250' \| 'tn3270' \| 'vt' \| 'hp6530'` | `'tn5250'` | Terminal protocol |
| `protocolProfile` | `ProtocolProfile` | - | Custom protocol profile (overrides `protocol`) |
| `screenData` | `ScreenData` | - | Direct screen data injection (bypasses polling) |
| `connectionStatus` | `ConnectionStatus` | - | Direct status injection |
| `inlineSignIn` | `boolean` | `true` | Show sign-in form when disconnected |
| `defaultProtocol` | `TerminalProtocol` | `'tn5250'` | Pre-selected protocol in sign-in form |
| `onSignIn` | `(config) => void` | - | Sign-in submit callback |
| `readOnly` | `boolean` | `false` | Disable keyboard input |
| `pollInterval` | `number` | `2000` | Screen polling interval in ms (0 to disable) |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `maxReconnectAttempts` | `number` | `5` | Max reconnect attempts |
| `embedded` | `boolean` | `false` | Compact embedded mode |
| `showHeader` | `boolean` | `true` | Show header bar |
| `typingAnimation` | `boolean` | `true` | Enable typing animation |
| `bootLoader` | `ReactNode \| false` | default | Custom boot loader or `false` to disable |
| `headerRight` | `ReactNode` | - | Content for right side of header |
| `overlay` | `ReactNode` | - | Custom overlay content |
| `onNotification` | `(msg, type) => void` | - | Notification callback |
| `onScreenChange` | `(screen) => void` | - | Screen change callback |
| `className` | `string` | - | Additional CSS class |
| `style` | `CSSProperties` | - | Inline styles |

## Key Types

```typescript
interface ScreenData {
  content: string;       // Newline-separated text (24 lines of 80 chars)
  cursor_row: number;    // 0-based cursor row
  cursor_col: number;    // 0-based cursor column
  rows?: number;         // Terminal rows (default 24)
  cols?: number;         // Terminal columns (default 80)
  fields?: Field[];      // Input/protected field definitions
}

interface ConnectionStatus {
  connected: boolean;
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'error';
  protocol?: TerminalProtocol;
  host?: string;
  error?: string;
}

interface Field {
  row: number;           // 0-based row
  col: number;           // 0-based column
  length: number;        // Field length in characters
  is_input: boolean;     // Accepts user input
  is_protected: boolean; // Read-only
}
```

## Theming

Override CSS custom properties to customize the look:

```css
:root {
  --terminal-green: #10b981;
  --terminal-white: #FFFFFF;
  --terminal-blue: #7B93FF;
  --terminal-bg: #000000;
  --terminal-card-bg: #0e1422;
  --terminal-card-border: #1e293b;
  --terminal-header-bg: #090e1a;
  --terminal-font: 'JetBrains Mono', 'Courier New', monospace;
}
```

## Exports

### Adapters

- `WebSocketAdapter` — Real-time WebSocket (works with proxy and worker)
- `RestAdapter` — HTTP polling

### Hooks

- `useTerminalConnection(adapter)` — Connection lifecycle
- `useTerminalScreen(adapter, interval, enabled)` — Screen polling
- `useTerminalInput(adapter)` — Send text/key operations
- `useTypingAnimation(content, enabled, budgetMs)` — Typing animation

### Protocol Profiles

- `getProtocolProfile(protocol)` — Get built-in profile by name
- `tn5250Profile`, `tn3270Profile`, `vtProfile`, `hp6530Profile`

### Utilities

- `positionToRowCol(content, position)` — Convert linear position to row/col
- `isFieldEntry(prev, next)` — Detect field entry vs screen transition

## License

MIT
