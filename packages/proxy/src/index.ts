import express from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'http';

// Re-export session store primitives so integrators can swap the default
// in-memory store for a custom implementation (e.g. Redis routing for
// multi-process deployments) before createProxy() is called.
export {
  type SessionStore,
  InMemorySessionStore,
  setSessionStore,
  getSessionStore,
  sessionLifecycle,
} from './session-store.js';

export interface ProxyOptions {
  /** Port to listen on (default: 3001) */
  port?: number;
}

export interface ProxyServer {
  /** The underlying HTTP server */
  server: HttpServer;
  /** The Express app */
  app: express.Express;
  /** The port the server is listening on */
  port: number;
  /** Stop the server */
  close(): Promise<void>;
}

/**
 * Create and start a green-screen proxy server.
 *
 * @example
 * ```ts
 * import { createProxy } from 'green-screen-proxy';
 *
 * const proxy = await createProxy({ port: 3001 });
 * console.log(`Proxy running on port ${proxy.port}`);
 *
 * // Later:
 * await proxy.close();
 * ```
 */
export async function createProxy(options: ProxyOptions = {}): Promise<ProxyServer> {
  const { port = 3001 } = options;

  const app = express();
  app.use(cors());
  app.use(express.json());

  const [{ default: routes }, { setupWebSocket, shutdownAllWsControllers }] = await Promise.all([
    import('./routes.js'),
    import('./websocket.js'),
  ]);
  app.use('/', routes);

  const server = createServer(app);

  let resolvedPort = port;
  const maxPort = port + 20;

  return new Promise<ProxyServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolvedPort++;
        if (resolvedPort > maxPort) {
          reject(new Error(`All ports ${port}–${maxPort} are in use`));
          return;
        }
        server.listen(resolvedPort);
      } else {
        reject(err);
      }
    });

    server.listen(resolvedPort, () => {
      // Attach WebSocket after successful listen to avoid EADDRINUSE
      // being re-emitted as an unhandled error on the WebSocketServer
      setupWebSocket(server);

      resolve({
        server,
        app,
        port: resolvedPort,
        async close() {
          // Drain live host connections BEFORE closing the HTTP server so
          // each TCP socket has a chance to send a clean FIN upstream.
          // Without this, abrupt process termination leaves host-side
          // resources dangling (e.g. IBM i virtual telnet device
          // descriptions stuck in VARY ON PENDING, blocking device-
          // restricted user profiles from signing on again).
          try {
            // 1. REST-created sessions tracked by the session store.
            const { getSessionStore } = await import('./session-store.js');
            for (const session of Array.from(getSessionStore().values())) {
              try { session.destroy(); } catch { /* ignore */ }
            }
            // 2. WS-created SessionControllers (live + orphaned).
            shutdownAllWsControllers();
          } catch { /* ignore */ }

          await new Promise<void>((res) => {
            server.close(() => res());
            // Safety timeout — give in-flight HTTP requests up to 5s to
            // finish before forcing exit. Session TCP FINs are sent
            // synchronously above, so the host has already started its
            // cleanup by the time this fires.
            setTimeout(() => res(), 5000);
          });
        },
      });
    });
  });
}
