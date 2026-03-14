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
- Pluggable adapter interface for any backend

## Installation

```bash
npm install green-screen-react
```

## Quick Start

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

## Adapter Interface

The terminal communicates with your backend through an adapter. Implement the `TerminalAdapter` interface or use the built-in `RestAdapter`.

```typescript
interface TerminalAdapter {
  getScreen(): Promise<ScreenData | null>;
  getStatus(): Promise<ConnectionStatus>;
  sendText(text: string): Promise<SendResult>;
  sendKey(key: string): Promise<SendResult>;
  connect(): Promise<SendResult>;
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
