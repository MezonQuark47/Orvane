// Which network this build of the app talks to.
//
//   npm run dev            Canton TestNet (Cantex Connect, Loop)
//   npm run dev:mainnet    Canton MainNet (Cantex Connect, Loop)
//   npm run dev:devnet     Canton DevNet (OneSwap, Loop), for testing
//   npm run dev:localnet   LocalNet with the Orvane pool and the Wallet Gateway
//
// VITE_ORVANE_NETWORK overrides the mode.

import { NETWORKS, networkOf, type NetworkId } from '../../../shared/networks.ts'

const fromMode = (mode: string): NetworkId | undefined => (mode in NETWORKS ? (mode as NetworkId) : undefined)

export const NETWORK = networkOf(import.meta.env.VITE_ORVANE_NETWORK ?? fromMode(import.meta.env.MODE) ?? 'testnet')

/** Where swaps fill on this network, by name; none where the Orvane pool runs instead (LocalNet). */
export const VENUE: string | undefined = NETWORK.cantex ? 'Cantex' : NETWORK.oneswap ? 'OneSwap' : undefined
