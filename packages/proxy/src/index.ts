import express from 'express';
import cors from 'cors';
import { createServer, Server as HttpServer } from 'http';

export interface ProxyOptions {
  /** Port to listen on (default: 3001) */
  port?: number;
  /** Use mock screens instead of real connections */
  mock?: boolean;
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
  const { port = 3001, mock = false } = options;

  const app = express();
  app.use(cors());
  app.use(express.json());

  let setupWebSocket: ((server: HttpServer) => void) | undefined;

  if (mock) {
    const { default: mockRoutes } = await import('./mock/mock-routes.js');
    app.use('/', mockRoutes);
  } else {
    const [{ default: routes }, { setupWebSocket: setupWs }] = await Promise.all([
      import('./routes.js'),
      import('./websocket.js'),
    ]);
    app.use('/', routes);
    setupWebSocket = setupWs;
  }

  const server = createServer(app);
  if (setupWebSocket) setupWebSocket(server);

  let resolvedPort = port;

  return new Promise<ProxyServer>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolvedPort++;
        server.listen(resolvedPort);
      } else {
        reject(err);
      }
    });

    server.listen(resolvedPort, () => {
      resolve({
        server,
        app,
        port: resolvedPort,
        close() {
          return new Promise<void>((res) => {
            server.close(() => res());
            setTimeout(() => res(), 1000);
          });
        },
      });
    });
  });
}
