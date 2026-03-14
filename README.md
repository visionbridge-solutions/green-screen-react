# green-screen-react

Multi-protocol legacy terminal emulator for React, with a companion proxy server for connecting to real hosts.

Supports **TN5250** (IBM i / AS/400), **TN3270** (z/OS mainframe), **VT220** (OpenVMS, Unix), and **HP 6530** (NonStop).

## Features

- **Multi-protocol** — TN5250, TN3270, VT220, HP 6530
- Protocol-specific color conventions and screen dimensions
- Keyboard input: text, function keys (F1-F24), tab, arrow keys
- Field-aware rendering with input field underlines
- Typing animation with correction detection
- Auto-reconnect with exponential backoff
- Fully themeable via CSS custom properties
- Zero runtime dependencies (peer deps: React 18+)
- Inline sign-in form (host, credentials, protocol picker)
- Pluggable adapter interface for any backend
- Mock mode for instant evaluation without a real host

## How It Works

Browsers cannot open raw TCP sockets to telnet hosts. The proxy server bridges this gap:

```
  Your React App          green-screen-proxy           Legacy Host
┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
│  <GreenScreen│  HTTP  │   Translates     │  TCP   │  IBM i       │
│   Terminal/> │◄──────►│   HTTP ↔ Telnet  │◄──────►│  Mainframe   │
│              │   WS   │                  │        │  VMS / etc.  │
└──────────────┘        └──────────────────┘        └──────────────┘
  npm install             npx green-screen-proxy
  green-screen-react
```

**You need two things:**

| What | Package | Install |
|------|---------|---------|
| React component | `green-screen-react` | `npm install green-screen-react` |
| Proxy server | `green-screen-proxy` | Run with `npx green-screen-proxy` (no install needed) |

## Quick Start

**Step 1 — Add the component to your React project:**

```bash
npm install green-screen-react
```

**Step 2 — Start the proxy server** (in a separate terminal):

```bash
npx green-screen-proxy --mock
```

This starts the proxy on `http://localhost:3001` with mock screens — no real host needed to try it out.

**Step 3 — Render the terminal:**

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

function App() {
  return <GreenScreenTerminal baseUrl="http://localhost:3001" />;
}
```

That's it. The terminal connects to the proxy, which handles protocol translation. Remove `--mock` when you're ready to connect to a real host.

## Proxy Server

The proxy is a lightweight Node.js server. Run it with `npx` — no global install required.

```bash
npx green-screen-proxy              # Start on port 3001
npx green-screen-proxy --mock       # Mock mode (no real host needed)
npx green-screen-proxy --port 8080  # Custom port
PORT=8080 npx green-screen-proxy    # Port via environment variable
```

If you prefer to install it (e.g. for deployment):

```bash
npm install -g green-screen-proxy   # Global install
green-screen-proxy                  # Run directly
```

### Connecting to a real host

Without `--mock`, the proxy opens real TCP connections. The sign-in form in the terminal collects host, port, protocol, and credentials — the proxy handles the rest.

Example: connecting to the public IBM i system at `pub400.com`:

```tsx
<GreenScreenTerminal baseUrl="http://localhost:3001" defaultProtocol="tn5250" />
```

Enter `pub400.com` as the host in the sign-in form, and the proxy connects over TCP port 23.

## Component Usage

### Minimal (inline sign-in)

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

// Sign-in form enabled by default — user enters host and credentials
<GreenScreenTerminal baseUrl="http://localhost:3001" />
```

### With a custom adapter

```tsx
import { GreenScreenTerminal, RestAdapter } from 'green-screen-react';
import 'green-screen-react/styles.css';

const adapter = new RestAdapter({
  baseUrl: 'https://your-server.com/api/terminal',
  headers: { Authorization: 'Bearer your-token' },
});

<GreenScreenTerminal adapter={adapter} protocol="tn5250" />
```

### Switching protocols

```tsx
<GreenScreenTerminal baseUrl="http://localhost:3001" protocol="tn3270" />
<GreenScreenTerminal baseUrl="http://localhost:3001" protocol="vt" />
<GreenScreenTerminal baseUrl="http://localhost:3001" protocol="hp6530" />
```

### Inline Sign-In

The sign-in form appears by default when disconnected. It collects host, port, protocol, and credentials, then calls `adapter.connect(config)` to establish the connection through the proxy.

```tsx
// Disable the form (use when you manage connections yourself)
<GreenScreenTerminal adapter={adapter} inlineSignIn={false} />

// Pre-select a protocol and listen for sign-in
<GreenScreenTerminal
  baseUrl="http://localhost:3001"
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

## Adapter Interface

The terminal communicates with your backend through an adapter. Implement `TerminalAdapter` or use the built-in `RestAdapter`.

```typescript
interface TerminalAdapter {
  getScreen(): Promise<ScreenData | null>;
  getStatus(): Promise<ConnectionStatus>;
  sendText(text: string): Promise<SendResult>;
  sendKey(key: string): Promise<SendResult>;
  connect(config?: ConnectConfig): Promise<SendResult>;
  disconnect(): Promise<SendResult>;
  reconnect(): Promise<SendResult>;
}
```

### Key Types

```typescript
interface ScreenData {
  content: string;       // Newline-separated text (24 lines of 80 chars)
  cursor_row: number;    // 0-based cursor row
  cursor_col: number;    // 0-based cursor column
  rows?: number;         // Terminal rows (default 24)
  cols?: number;         // Terminal columns (default 80)
  fields?: Field[];      // Input/protected field definitions
  screen_signature?: string;
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

### RestAdapter

Maps adapter methods to HTTP endpoints (relative to `baseUrl`):

| Method | Path | Request Body | Response |
|--------|------|-------------|----------|
| GET | `/screen` | - | `{ content, cursor_row, cursor_col, fields, screen_signature }` |
| GET | `/status` | - | `{ connected, status, protocol, host }` |
| POST | `/connect` | `{ host, port, protocol }` | `{ success, sessionId, content, cursor_row, cursor_col }` |
| POST | `/send-text` | `{ text }` | `{ success, content, cursor_row, cursor_col }` |
| POST | `/send-key` | `{ key }` | `{ success, content, cursor_row, cursor_col }` |
| POST | `/disconnect` | - | `{ success }` |
| POST | `/reconnect` | - | `{ success, content, cursor_row, cursor_col }` |

**Session management:** The `/connect` response includes a `sessionId`. Pass it as the `X-Session-Id` header on subsequent requests to target a specific session. If omitted, the proxy uses the default (single) session.

### Custom Adapters

Implement `TerminalAdapter` to connect to any backend:

```typescript
import type { TerminalAdapter, ScreenData, ConnectionStatus, SendResult } from 'green-screen-react';

class MyAdapter implements TerminalAdapter {
  async getScreen(): Promise<ScreenData | null> { /* fetch screen data */ }
  async getStatus(): Promise<ConnectionStatus> { /* fetch status */ }
  async sendText(text: string): Promise<SendResult> { /* send text */ }
  async sendKey(key: string): Promise<SendResult> { /* send key */ }
  async connect(config?: ConnectConfig): Promise<SendResult> { /* connect */ }
  async disconnect(): Promise<SendResult> { /* disconnect */ }
  async reconnect(): Promise<SendResult> { /* reconnect */ }
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
- `getRowColorClass(rowIndex, content)` — Row color convention
- `parseHeaderRow(line)` — Parse header row into colored segments

## License

MIT
