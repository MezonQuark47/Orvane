import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /v2 -> Canton JSON Ledger API (sandbox), /api -> Orvane operator service.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v2': 'http://localhost:6864',
      '/api': 'http://localhost:7600',
    },
    fs: { allow: ['..'] },
  },
  build: {
    // three.js lives in its own lazy chunk
    chunkSizeWarningLimit: 1100,
  },
})
