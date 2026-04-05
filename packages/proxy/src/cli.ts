#!/usr/bin/env node

// Check for deploy subcommand first (before parseArgs)
const subcommand = process.argv[2];
if (subcommand === 'deploy') {
  const { deploy } = await import('./deploy.js');
  deploy(process.argv.slice(3));
  process.exit(0);
}

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`green-screen-proxy — WebSocket/REST proxy for legacy terminal connections

Usage: green-screen-proxy [options]
       green-screen-proxy deploy [deploy-options]

Commands:
  deploy              Deploy as a Cloudflare Worker (run "deploy --help" for options)

Options:
  --port NUM     Port to listen on (default: 3001, or PORT env var)
  -h, --help     Show this help message

Examples:
  npx green-screen-proxy                  # Start proxy on port 3001
  npx green-screen-proxy --port 8080      # Start on port 8080
  npx green-screen-proxy deploy           # Deploy to Cloudflare Workers`);
  process.exit(0);
}

if (values.port) {
  process.env.PORT = values.port;
}

await import('./server.js');
