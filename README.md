# green-screen-react

Multi-protocol legacy terminal React component supporting TN5250, TN3270, VT220, and HP 6530.

## Features

- **Multi-protocol** — TN5250 (IBM i), TN3270 (mainframe), VT220, HP 6530
- Protocol-specific color conventions and screen dimensions
- Keyboard input: text, function keys (F1-F24), tab, arrow keys
- Field-aware rendering with input field underlines
- Typing animation with correction detection
- Auto-reconnect with exponential backoff
- Fully themeable via CSS custom properties
- Zero runtime dependencies (peer deps: React 18+)
- Optional inline sign-in form (host, credentials, protocol picker)
- Pluggable adapter interface for any backend

## Installation

```bash
npm install green-screen-react
```

## Quick Start

Install and render — no configuration needed:

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

function App() {
  return <GreenScreenTerminal />;
}
```

The inline sign-in form is enabled by default. Users enter host, port, protocol, and credentials directly in the terminal, and a `RestAdapter` is auto-created to connect to `http://{host}:{port}`.

### With a Base URL

If your backend is at a known URL, use the `baseUrl` shorthand:

```tsx
<GreenScreenTerminal baseUrl="https://your-server.com/api/terminal" />
```

### With a Custom Adapter

For full control, provide your own adapter:

```tsx
import { GreenScreenTerminal, RestAdapter } from 'green-screen-react';
import 'green-screen-react/styles.css';

const adapter = new RestAdapter({
  baseUrl: 'https://your-server.com/api/terminal',
  headers: { Authorization: 'Bearer your-token' },
});

function App() {
  return <GreenScreenTerminal adapter={adapter} protocol="tn5250" />;
}
```

### Switching Protocols

```tsx
<GreenScreenTerminal adapter={adapter} protocol="tn3270" />
<GreenScreenTerminal adapter={adapter} protocol="vt" />
<GreenScreenTerminal adapter={adapter} protocol="hp6530" />
```

### Inline Sign-In

The sign-in form is shown by default when disconnected. To disable it or customize:

```tsx
<GreenScreenTerminal
  adapter={adapter}
  inlineSignIn={false}  // disable the form
/>

<GreenScreenTerminal
  defaultProtocol="tn3270"
  onSignIn={(config) => console.log('Connecting to', config.host)}
/>
```

The form collects host, port, protocol, and credentials. On submit, it calls `adapter.connect(config)` with `{ host, port, protocol, username, password }`.

## Adapter Interface

The terminal communicates with your backend through an adapter. Implement the `TerminalAdapter` interface or use the built-in `RestAdapter`.

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

### RestAdapter

For HTTP-based backends with these endpoints (relative to `baseUrl`):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/screen` | Get current screen content |
| GET | `/status` | Get connection status |
| POST | `/send-text` | Send text input `{ text }` |
| POST | `/send-key` | Send special key `{ key }` |
| POST | `/connect` | Establish connection |
| POST | `/disconnect` | Close connection |
| POST | `/reconnect` | Reconnect |

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `adapter` | `TerminalAdapter` | **required** | Backend communication adapter |
| `protocol` | `'tn5250' \| 'tn3270' \| 'vt' \| 'hp6530'` | `'tn5250'` | Terminal protocol |
| `protocolProfile` | `ProtocolProfile` | - | Custom protocol profile (overrides `protocol`) |
| `screenData` | `ScreenData` | - | Direct screen data injection (bypasses polling) |
| `connectionStatus` | `ConnectionStatus` | - | Direct status injection |
| `inlineSignIn` | `boolean` | `false` | Show sign-in form when disconnected |
| `defaultProtocol` | `TerminalProtocol` | `'tn5250'` | Pre-selected protocol in sign-in form |
| `onSignIn` | `(config) => void` | - | Sign-in submit callback |
| `readOnly` | `boolean` | `false` | Disable keyboard input |
| `pollInterval` | `number` | `2000` | Polling interval in ms (0 to disable) |
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
