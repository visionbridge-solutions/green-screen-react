#!/usr/bin/env node
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    port: { type: 'string', default: '' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`green-screen-proxy — WebSocket/REST proxy for legacy terminal connections

Usage: green-screen-proxy [options]

Options:
  --mock       Run with mock data (no real host connection needed)
  --port NUM   Port to listen on (default: 3001, or PORT env var)
  -h, --help   Show this help message

Examples:
  npx green-screen-proxy                  # Start proxy on port 3001
  npx green-screen-proxy --mock           # Start with mock screens
  npx green-screen-proxy --port 8080      # Start on port 8080`);
  process.exit(0);
}

if (values.port) {
  process.env.PORT = values.port;
}

if (values.mock) {
  process.argv.push('--mock');
}

await import('./server.js');
