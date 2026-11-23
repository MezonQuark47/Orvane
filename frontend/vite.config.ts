import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// /api -> the Orvane operator (public pool data and the registry proxy).
//
// There is deliberately no ledger proxy: the app reads a user's contracts
// through their own wallet (CIP-0103 ledgerApi) and never holds ledger
// credentials of its own.
export default defineConfig(({ mode }) => {
  // the deployed address, for the link-preview tags in index.html (they need
  // absolute links); relative until the site has one
  const site = (loadEnv(mode, process.cwd(), 'VITE_').VITE_SITE_URL ?? '').replace(/\/$/, '')
  return {
    plugins: [react(), { name: 'site-url', transformIndexHtml: (html: string) => html.replaceAll('%SITE_URL%', site) }],
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
  }
})
