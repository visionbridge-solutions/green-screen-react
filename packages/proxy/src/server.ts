import { createProxy } from './index.js';

const isMock = process.argv.includes('--mock');
const PORT = parseInt(process.env.PORT || '3001', 10);

const proxy = await createProxy({ port: PORT, mock: isMock });

console.log(`Green Screen proxy server running on http://localhost:${proxy.port}`);
if (isMock) {
  console.log('Running in MOCK mode (no real IBM i connection)');
}

function shutdown() {
  proxy.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
