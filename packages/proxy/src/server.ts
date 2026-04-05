import { createProxy } from './index.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

const proxy = await createProxy({ port: PORT });

console.log(`Green Screen proxy server running on http://localhost:${proxy.port}`);

function shutdown() {
  proxy.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
