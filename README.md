# tn5250-react

Web-based IBM TN5250 terminal emulator React component. The first open-source 5250 terminal for the browser.

## Features

- 24x80 and 27x132 screen rendering with IBM 5250 color conventions
- Keyboard input: text, function keys (F1-F24), tab, arrow keys
- Field-aware rendering with input field underlines and highlighted protected fields
- Typing animation for field entries with correction detection
- Auto-reconnect with exponential backoff
- Focus lock mode for keyboard capture
- Fully themeable via CSS custom properties
- Zero runtime dependencies (peer deps: React 18+)
- Pluggable adapter interface for any backend

## Installation

```bash
npm install tn5250-react
```

## Quick Start

```tsx
import { TN5250Terminal, RestAdapter } from 'tn5250-react';
import 'tn5250-react/styles.css';

const adapter = new RestAdapter({
  baseUrl: 'https://your-server.com/api/tn5250',
  headers: { Authorization: 'Bearer your-token' },
});

function App() {
  return <TN5250Terminal adapter={adapter} />;
}
```

## Adapter Interface

The terminal communicates with your backend through an adapter. Implement the `TN5250Adapter` interface or use the built-in `RestAdapter`.

```typescript
interface TN5250Adapter {
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

### Custom Adapter

```typescript
class WebSocketAdapter implements TN5250Adapter {
  constructor(private ws: WebSocket) {}

  async getScreen() {
    // Return screen data from WebSocket state
  }
  // ... implement other methods
}
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `adapter` | `TN5250Adapter` | **required** | Backend communication adapter |
| `screenData` | `ScreenData` | - | Direct screen data injection (bypasses polling) |
| `connectionStatus` | `ConnectionStatus` | - | Direct status injection |
| `readOnly` | `boolean` | `false` | Disable keyboard input |
| `pollInterval` | `number` | `2000` | Polling interval in ms (0 to disable) |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `maxReconnectAttempts` | `number` | `5` | Max reconnect attempts |
| `embedded` | `boolean` | `false` | Compact embedded mode |
| `showHeader` | `boolean` | `true` | Show header bar |
| `typingAnimation` | `boolean` | `true` | Enable typing animation |
| `typingBudgetMs` | `number` | `60` | Typing animation budget |
| `bootLoader` | `ReactNode \| false` | default | Custom boot loader or `false` to disable |
| `headerRight` | `ReactNode` | - | Content for right side of header |
| `overlay` | `ReactNode` | - | Custom overlay content |
| `onNotification` | `(msg, type) => void` | - | Notification callback |
| `onScreenChange` | `(screen) => void` | - | Screen change callback |
| `onMinimize` | `() => void` | - | Minimize callback (embedded mode) |
| `className` | `string` | - | Additional CSS class |
| `style` | `CSSProperties` | - | Inline styles |

## Theming

Override CSS custom properties to customize the look:

```css
:root {
  --tn5250-green: #10b981;
  --tn5250-white: #FFFFFF;
  --tn5250-blue: #7B93FF;
  --tn5250-bg: #000000;
  --tn5250-card-bg: #0e1422;
  --tn5250-card-border: #1e293b;
  --tn5250-header-bg: #090e1a;
  --tn5250-font: 'JetBrains Mono', 'Courier New', monospace;
}
```

## Exported Hooks

- `useTN5250Connection(adapter)` — Connection lifecycle
- `useTN5250Screen(adapter, interval, enabled)` — Screen polling
- `useTN5250Terminal(adapter)` — Send text/key operations
- `useTypingAnimation(content, enabled, budgetMs)` — Typing animation

## Exported Utilities

- `positionToRowCol(content, position)` — Convert linear position to row/col
- `isFieldEntry(prev, next)` — Detect field entry vs screen transition
- `getRowColorClass(rowIndex, content)` — IBM 5250 row color convention
- `parseHeaderRow(line)` — Parse header row into colored segments

## License

MIT
