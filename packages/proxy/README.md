# green-screen-proxy

WebSocket-to-TCP proxy for [green-screen-react](https://www.npmjs.com/package/green-screen-react). Bridges browser WebSocket connections to TN5250, TN3270, VT220, and HP 6530 hosts over TCP.

## Install

```bash
npm install green-screen-proxy
```

## Usage

```bash
npx green-screen-proxy              # Start on port 3001
npx green-screen-proxy --mock       # Mock mode (no real host needed)
npx green-screen-proxy --standalone # Proxy + built-in web terminal UI
npx green-screen-proxy --port 8080  # Custom port
npx green-screen-terminal            # Shorthand for --standalone
```

### Mock mode

With `--mock`, the proxy serves mock terminal screens — useful for trying out the component without a real host connection.

### Connecting to a real host

Without `--mock`, the proxy opens real TCP connections. The sign-in form in the React component collects host, port, protocol, and credentials — the proxy handles the rest.

## Cloudflare Worker Deployment

Deploy a serverless proxy to Cloudflare Workers:

```bash
npx green-screen-proxy deploy                             # Default settings
npx green-screen-proxy deploy --name my-terminal          # Custom worker name
npx green-screen-proxy deploy --origins https://myapp.com # Lock CORS to your domain
```

This will:
1. Install Wrangler (Cloudflare CLI) if not present
2. Log you in to Cloudflare if needed
3. Deploy the worker and print the URL
4. Save the URL to `.env.local` (auto-detects Vite, Next.js, CRA)

Then point the React component at it:

```tsx
const adapter = new WebSocketAdapter({
  workerUrl: 'https://green-screen-worker.your-subdomain.workers.dev'
});
```

## Programmatic API

Start the proxy from your own Node.js app:

```typescript
import { createProxy } from 'green-screen-proxy';

const proxy = await createProxy({ port: 3001 });
console.log(`Proxy running on port ${proxy.port}`);

// Later:
await proxy.close();
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | `3001` | Port to listen on |
| `mock` | `boolean` | `false` | Use mock screens |
| `standalone` | `boolean` | `false` | Serve built-in web UI |

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `server` | `HttpServer` | The underlying HTTP server |
| `app` | `Express` | The Express app (add your own middleware) |
| `port` | `number` | The actual port (may differ if original was in use) |
| `close()` | `Promise<void>` | Stop the server |

## How It Works

```
  Browser                  Proxy                    Host
┌────────────┐        ┌────────────┐        ┌────────────┐
│ WebSocket  │  WS    │  Express   │  TCP   │  IBM i     │
│ client     │◄──────►│  :3001     │◄──────►│  Mainframe │
└────────────┘        └────────────┘        └────────────┘
```

The proxy manages sessions — each WebSocket connection gets its own TCP session to the target host. Screen data is parsed into a protocol-agnostic format and pushed to the client in real time.

## License

MIT
