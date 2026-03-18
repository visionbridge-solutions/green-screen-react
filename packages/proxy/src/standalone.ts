#!/usr/bin/env node

// Shorthand: `npx green-screen-terminal` → `npx green-screen-proxy --standalone`
process.argv.push('--standalone');
await import('./cli.js');

export {};
