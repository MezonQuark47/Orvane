import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { hmacJwt } from '../shared/ledger.ts'

// /v2 -> Canton JSON Ledger API, /api -> Orvane operator service.
//
// npm run dev            -> `dpm sandbox` on :6864, no auth.
// npm run dev:localnet   -> Splice LocalNet app-provider participant on :3975.
// The dev proxy adds the LocalNet dev JWT, so no secret reaches the browser.
export default defineConfig(async ({ mode }) => {
  const localnet = (process.env.ORVANE_NETWORK ?? mode) === 'localnet'
  const token = localnet
    ? await hmacJwt({ secret: process.env.LOCALNET_AUTH_SECRET ?? 'unsafe', audience: 'https://canton.network.global' }, 'orvane')
    : undefined

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/v2': {
          target: localnet ? 'http://localhost:3975' : 'http://localhost:6864',
          changeOrigin: true,
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        },
        // Token-standard registry + Scan (LocalNet). Must come before /api.
        '/registry': { target: 'http://scan.localhost:4000', changeOrigin: true },
        '/api/scan': { target: 'http://scan.localhost:4000', changeOrigin: true },
        '/api': 'http://localhost:7600',
      },
      fs: { allow: ['..'] },
    },
    build: {
      // three.js lives in its own lazy chunk
      chunkSizeWarningLimit: 1100,
    },
  }
})
