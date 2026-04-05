# green-screen-proxy

WebSocket-to-TCP proxy for [green-screen-react](https://www.npmjs.com/package/green-screen-react). Bridges browser WebSocket connections to TN5250, TN3270, VT220, and HP 6530 hosts over TCP.

## Install

```bash
npm install green-screen-proxy
```

## Usage

```bash
npx green-screen-proxy              # Start on port 3001
npx green-screen-proxy --port 8080  # Custom port
npx green-screen-terminal           # Proxy + web terminal UI (separate package)
```

### Connecting to a host

The proxy opens real TCP connections. The sign-in form in the React component collects host, port, protocol, and credentials — the proxy handles the rest.

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

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `server` | `HttpServer` | The underlying HTTP server |
| `app` | `Express` | The Express app (add your own middleware) |
| `port` | `number` | The actual port (may differ if original was in use) |
| `close()` | `Promise<void>` | Stop the server |

## HTTP endpoints

All routes accept an `X-Session-Id` header (or `?sessionId=` query) to target a specific session; omit it when there's exactly one session and the proxy will use it by default.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/connect` | Open a session to a host. Optionally includes `username`/`password` for auto sign-in. |
| `POST` | `/disconnect` | Close the current session. |
| `POST` | `/reconnect` | Reconnect the current session's TCP socket. |
| `GET`  | `/screen` | Read the latest `ScreenData` snapshot. |
| `GET`  | `/status` | Read `ConnectionStatus`. |
| `POST` | `/send-text` | Type text at the current cursor. |
| `POST` | `/send-key` | Send a key (`Enter`, `F1`–`F24`, `Tab`, arrows, etc.). |
| `POST` | `/set-cursor` | Move cursor to `{row, col}`. |
| `POST` | `/batch` | Atomic batch of `{type: 'key'|'text'|'setCursor', ...}` operations. |
| `GET`  | `/read-mdt` | **v1.2.0** — return input fields whose MDT bit is set. `?includeUnmodified=1` returns all input fields. |
| `POST` | `/session/resume` | **v1.2.0** — probe whether a session still exists; returns current status + screen. Use on page reload for REST-only clients. |
| `POST` | `/session/authenticated` | **v1.2.0** — flip the session status to `authenticated`. For integrators running their own sign-on cascade. |
| `POST` | `/wait-for-fields` | **v1.2.0** — wait until the current screen has at least `minFields` input fields (or `timeoutMs`). Short-circuits if already satisfied. |

## WebSocket protocol

Single endpoint at `ws(s)://host/ws`. Clients send JSON commands, receive JSON events.

Commands the client sends:

| `type` | Purpose |
|---|---|
| `connect` | Open a session (same body as `POST /connect`). |
| `reattach` | Re-bind to an existing session by `sessionId`. |
| `text` | Send text input. |
| `key` | Send a key. |
| `setCursor` | Move cursor. |
| `readMdt` | **v1.2.0** — request modified field values; response is `{type: 'mdt', data: {fields, modifiedOnly}}`. |
| `markAuthenticated` | **v1.2.0** — flip status to `authenticated`. |
| `waitForFields` | **v1.2.0** — wait for a screen with at least N input fields. |
| `disconnect` | Close the session. |

Events the proxy pushes:

| `type` | Meaning |
|---|---|
| `screen` | New `ScreenData` snapshot. |
| `status` | `ConnectionStatus` change. |
| `connected` | Session established after `connect`/`reattach`. |
| `cursor` | Lightweight cursor-only update (local ops like Tab/arrows). |
| `mdt` | Response to a `readMdt` command. |
| `session.lost` | **v1.2.0** — session died (TCP drop, idle timeout, destroy). |
| `session.resumed` | **v1.2.0** — a client successfully reattached to this session. |
| `error` | Generic error with a `message`. |

## Pluggable session store

Sessions live in an in-memory Map by default. Integrators can plug their own store (e.g. for multi-process routing via Redis) before the server accepts connections:

```typescript
import { createProxy, setSessionStore, type SessionStore } from 'green-screen-proxy';

class MyStore implements SessionStore {
  set(id, session) { /* ... */ }
  get(id) { /* ... */ }
  delete(id) { /* ... */ }
  has(id) { /* ... */ }
  values() { /* ... */ }
  size() { /* ... */ }
}

setSessionStore(new MyStore());
const proxy = await createProxy({ port: 3001 });
```

The store holds live `Session` instances (each owns a TCP socket + parser state), so a cross-process store needs to additionally implement request routing to the owning process — that's out of scope for the interface itself.

### Session lifecycle events

Subscribe to the global lifecycle bus to observe session transitions at the server:

```typescript
import { sessionLifecycle } from 'green-screen-proxy';

sessionLifecycle.on('session.lost', (sessionId, status) => {
  console.log('session died:', sessionId, status.status);
});

sessionLifecycle.on('session.resumed', (sessionId) => {
  console.log('client reattached:', sessionId);
});
```

These same events are forwarded to WebSocket clients watching the affected session — clients subscribe on the adapter side via `WebSocketAdapter.onSessionLost()` / `onSessionResumed()`.

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
