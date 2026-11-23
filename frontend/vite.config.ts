import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// /api -> the Orvane operator (public pool data and the registry proxy).
//
// There is deliberately no ledger proxy: the app reads a user's contracts
// through their own wallet (CIP-0103 ledgerApi) and never holds ledger
// credentials of its own.
export default defineConfig(({ mode }) => {
  // the deployed address, for the link-preview tags in index.html (they need
  // absolute links): VITE_SITE_URL, else Vercel's production address, else
  // relative links
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  const site = (loadEnv(mode, process.cwd(), 'VITE_').VITE_SITE_URL || (vercel ? `https://${vercel}` : '')).replace(/\/$/, '')
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
      // fonts stay files, never data: URLs, so the CSP can keep font-src to 'self' (vercel.json)
      assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined),
    },
  }
})
