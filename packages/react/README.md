# green-screen-react

Multi-protocol legacy terminal React component. Connects to **TN5250** (IBM i / AS/400), **TN3270** (z/OS mainframe), **VT220** (OpenVMS, Unix), and **HP 6530** (NonStop) hosts.

[**Live Preview**](https://visionbridge-solutions.github.io/green-screen-react/)

## Install

```bash
npm install green-screen-react green-screen-proxy
```

## Quick Start

Start the proxy (separate terminal):

```bash
npx green-screen-proxy
```

Or start it programmatically from your app:

```typescript
import { createProxy } from 'green-screen-proxy';
await createProxy({ port: 3001 });
```

Render the component:

```tsx
import { GreenScreenTerminal } from 'green-screen-react';
import 'green-screen-react/styles.css';

function App() {
  return <GreenScreenTerminal />;
}
```

Connects to `localhost:3001` automatically. Use the sign-in form to connect to a real host.

## Adapters

### WebSocketAdapter (recommended)

Real-time bidirectional WebSocket. Works with both the Node.js proxy and the Cloudflare Worker.

```tsx
import { WebSocketAdapter } from 'green-screen-react';

// Local proxy (default)
const adapter = new WebSocketAdapter({ workerUrl: 'http://localhost:3001' });

// Cloudflare Worker
const adapter = new WebSocketAdapter({
  workerUrl: 'https://green-screen-worker.your-subdomain.workers.dev'
});

<GreenScreenTerminal adapter={adapter} />
```

### RestAdapter

For backends that expose a REST API:

```tsx
import { RestAdapter } from 'green-screen-react';

const adapter = new RestAdapter({
  baseUrl: 'https://your-server.com/api/terminal',
  headers: { Authorization: 'Bearer your-token' },
});
```

### Custom Adapter

Implement `TerminalAdapter` to connect to any backend:

```typescript
import type { TerminalAdapter } from 'green-screen-react';

class MyAdapter implements TerminalAdapter {
  async getScreen() { /* ... */ }
  async getStatus() { /* ... */ }
  async sendText(text: string) { /* ... */ }
  async sendKey(key: string) { /* ... */ }
  async connect(config?) { /* ... */ }
  async disconnect() { /* ... */ }
  async reconnect() { /* ... */ }
}
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `adapter` | `TerminalAdapter` | auto | Backend adapter |
| `protocol` | `'tn5250' \| 'tn3270' \| 'vt' \| 'hp6530'` | `'tn5250'` | Terminal protocol |
| `inlineSignIn` | `boolean` | `true` | Show sign-in form when disconnected |
| `defaultProtocol` | `TerminalProtocol` | `'tn5250'` | Pre-selected protocol in sign-in |
| `readOnly` | `boolean` | `false` | Disable keyboard input |
| `pollInterval` | `number` | `2000` | Screen polling interval (ms) |
| `autoReconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `embedded` | `boolean` | `false` | Compact embedded mode |
| `showHeader` | `boolean` | `true` | Show header bar |
| `typingAnimation` | `boolean` | `true` | Enable typing animation |
| `bootLoader` | `ReactNode \| false` | default | Custom boot loader |
| `onSignIn` | `(config) => void` | - | Sign-in callback |
| `onScreenChange` | `(screen) => void` | - | Screen change callback |
| `className` | `string` | - | CSS class |
| `style` | `CSSProperties` | - | Inline styles |

## Theming

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

## License

MIT
