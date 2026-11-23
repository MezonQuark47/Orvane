// The networks Orvane runs on and what it uses on each.
//
// Swaps go through Cantex Connect, which runs on TestNet and MainNet. Cantex
// has no DevNet, so there swaps go through OneSwap instead, for testing. The
// Orvane pool (self-custodial liquidity) is kept for later and only runs on
// LocalNet, behind the `pool` flag.

import type { Instrument } from './cantex.ts'

export type NetworkId = 'localnet' | 'devnet' | 'testnet' | 'mainnet'

export interface NetworkInfo {
  id: NetworkId
  label: string
  /** Cantex Connect, where it exists */
  cantex?: {
    api: string
    ws: string
    swapParty: string
    /**
     * Confirmed: the party Cantex documents. Inferred: Cantex's party name in
     * Cantex's namespace on that network, read from its pool proofs; to be
     * confirmed with Cantex.
     */
    swapPartySource: 'documented' | 'inferred'
    /** the outside market price Orvane compares pool prices with */
    referenceMarket: string
  }
  /**
   * OneSwap, DevNet only. `api` is Orvane's own forwarder (api/oneswap.ts),
   * which adds the integrator key OneSwap needs to open a swap.
   */
  oneswap?: { api: string }
  /** Five North Loop's network name */
  loop?: 'devnet' | 'testnet' | 'mainnet'
  /** the CIP-0103 Wallet Gateway (LocalNet) */
  gateway: boolean
  /** Orvane's own pool, kept for later */
  pool: boolean
  /**
   * Orvane's transfer proxy (shared/proxy.ts), published by
   * scripts/proxy-setup.ts. Set once Orvane's party runs on a validator of
   * this network; without it swaps are plain transfers.
   */
  proxy?: string
  cc: Instrument
}

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  localnet: {
    id: 'localnet',
    label: 'Canton LocalNet',
    gateway: true,
    pool: true,
    // LocalNet's DSO changes with every fresh LocalNet; the app reads it from the operator
    cc: { admin: '', id: 'Amulet' },
  },
  devnet: {
    id: 'devnet',
    label: 'Canton DevNet',
    oneswap: { api: '/api/oneswap' },
    loop: 'devnet',
    gateway: false,
    pool: false,
    // read from OneSwap's pools at runtime
    cc: { admin: '', id: 'Amulet' },
  },
  testnet: {
    id: 'testnet',
    label: 'Canton TestNet',
    cantex: {
      api: 'https://api.testnet.cantex.io/v1/public',
      ws: 'wss://api.testnet.cantex.io/v1/ws/public',
      swapParty: 'cantex-swap::12206ba030ccad8ebc6611b535ecc300698db5aa7e842d0e2cc8b49cf43e1a2fb7f8',
      swapPartySource: 'inferred',
      referenceMarket: 'CC-USDC',
    },
    loop: 'testnet',
    gateway: false,
    pool: false,
    cc: { admin: 'DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337', id: 'Amulet' },
  },
  mainnet: {
    id: 'mainnet',
    label: 'Canton MainNet',
    cantex: {
      api: 'https://api.cantex.io/v1/public',
      ws: 'wss://api.cantex.io/v1/ws/public',
      swapParty: 'cantex-swap::122038c015864f106cfed48bb9106b7c89982368d27956ffcdfda6c38328f0909b8c',
      swapPartySource: 'documented',
      referenceMarket: 'CC-USDC',
    },
    loop: 'mainnet',
    gateway: false,
    pool: false,
    // read from Cantex's token list at runtime; MainNet's DSO is not hard-coded
    cc: { admin: '', id: 'Amulet' },
  },
}

export const networkOf = (id: string | undefined): NetworkInfo => NETWORKS[(id as NetworkId) ?? 'testnet'] ?? NETWORKS.testnet
