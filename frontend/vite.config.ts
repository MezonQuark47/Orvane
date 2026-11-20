import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api -> the Orvane operator (public pool data and the registry proxy).
//
// There is deliberately no ledger proxy: the app reads a user's contracts
// through their own wallet (CIP-0103 ledgerApi) and never holds ledger
// credentials of its own.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.ORVANE_OPERATOR_URL ?? 'http://localhost:7600',
    },
    fs: { allow: ['..'] },
  },
  build: {
    // three.js lives in its own lazy chunk
    chunkSizeWarningLimit: 1200,
  },
})
