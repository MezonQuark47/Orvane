// Which network this build of the app talks to.
//
//   npm run dev            Canton TestNet (Cantex Connect, Loop)
//   npm run dev:mainnet    Canton MainNet
//   npm run dev:localnet   LocalNet with the Orvane pool and the Wallet Gateway
//
// VITE_ORVANE_NETWORK overrides the mode.

import { NETWORKS, networkOf, type NetworkId } from '../../../shared/networks.ts'

const fromMode = (mode: string): NetworkId | undefined => (mode in NETWORKS ? (mode as NetworkId) : undefined)

export const NETWORK = networkOf(import.meta.env.VITE_ORVANE_NETWORK ?? fromMode(import.meta.env.MODE) ?? 'testnet')
