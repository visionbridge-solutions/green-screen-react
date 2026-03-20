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

import { existsSync } from 'node:fs';

const url = `http://localhost:${proxy.port}?mode=standalone`;
if (proxy.port !== 3001) {
  console.log(`Port 3001 was in use, using port ${proxy.port} instead`);
}
console.log(`Green Screen Terminal running at http://localhost:${proxy.port}`);
if (isMock) {
  console.log('Running in MOCK mode');
}

// Open browser — prefer Chrome app mode for a native terminal-like window
function openBrowser(target) {
  const platform = process.platform;
  const appArgs = [`--app=${target}`, '--window-size=800,600'];

  if (platform === 'darwin') {
    // --app flag opens a chromeless window; --window-size is ignored when
    // Chrome is already running, so we resize via AppleScript after a delay.
    execFile('open', ['-na', 'Google Chrome', '--args', `--app=${target}`], (err) => {
      if (err) { execFile('open', [target]); return; }
      setTimeout(() => {
        const resize = 'tell application "Google Chrome" to set bounds of front window to {100, 100, 900, 700}';
        execFile('osascript', ['-e', resize]);
      }, 500);
    });
  } else if (platform === 'win32') {
    const chromePaths = [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    const chrome = chromePaths.find(p => existsSync(p));
    if (chrome) {
      execFile(chrome, appArgs);
    } else {
      execFile('cmd', ['/c', 'start', target]);
    }
  } else {
    execFile('which', ['google-chrome'], (err) => {
      if (!err) {
        execFile('google-chrome', appArgs);
      } else {
        execFile('which', ['chromium-browser'], (err2) => {
          if (!err2) execFile('chromium-browser', appArgs);
          else execFile('xdg-open', [target]);
        });
      }
    });
  }
}

openBrowser(url);

function shutdown() {
  proxy.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
