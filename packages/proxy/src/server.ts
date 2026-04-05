import { createProxy } from './index.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

const proxy = await createProxy({ port: PORT });

console.log(`Green Screen proxy server running on http://localhost:${proxy.port}`);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[proxy] Received ${signal}, draining sessions...`);
  proxy.close()
    .then(() => {
      console.log('[proxy] Shutdown complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[proxy] Error during shutdown:', err);
      process.exit(1);
    });
  // Safety net: if close() hangs for any reason, force exit after 8s.
  // Docker's default SIGTERM grace period is 10s, so leave headroom
  // below that. Session drain itself is synchronous (socket.end() is
  // non-blocking); the HTTP server.close() is what can take time.
  setTimeout(() => {
    console.error('[proxy] Shutdown timeout, forcing exit');
    process.exit(1);
  }, 8000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
