#!/usr/bin/env node

import { createProxy } from 'green-screen-proxy';
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiPath = join(__dirname, '..', 'ui');

const isMock = process.argv.includes('--mock');
const proxy = await createProxy({ port: 3001, mock: isMock });

// Serve the terminal UI
proxy.app.use(express.static(uiPath));
proxy.app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/connect')) {
    return next();
  }
  res.sendFile(join(uiPath, 'index.html'));
});

const url = `http://localhost:${proxy.port}`;
console.log(`Green Screen Terminal running at ${url}`);
if (isMock) {
  console.log('Running in MOCK mode');
}

// Open browser
const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
execFile(openCmd, [url]);

function shutdown() {
  proxy.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
