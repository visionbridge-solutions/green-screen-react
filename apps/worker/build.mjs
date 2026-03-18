import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(__dirname, 'src/index.ts')],
  bundle: true,
  outfile: resolve(__dirname, 'dist/index.js'),
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  // Replace net module with our Cloudflare-compatible shim
  // Map bare Node.js specifiers to node: prefixed (required for Workers nodejs_compat)
  alias: {
    'net': resolve(__dirname, 'src/net-shim.ts'),
    'events': 'node:events',
    'crypto': 'node:crypto',
    'buffer': 'node:buffer',
  },
  // Runtime imports — don't bundle these
  external: ['cloudflare:sockets', 'node:events', 'node:crypto', 'node:buffer'],
  conditions: ['workerd', 'worker', 'import'],
  define: {
    'global': 'globalThis',
  },
})

console.log('Build complete: dist/index.js')
