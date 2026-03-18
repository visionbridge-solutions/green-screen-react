import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_URL || '/green-screen-react/',
  resolve: {
    alias: {
      'green-screen-react/styles.css': path.resolve(__dirname, '../../packages/react/src/styles/terminal.css'),
      'green-screen-react': path.resolve(__dirname, '../../packages/react/src/index.ts'),
    },
  },
})
