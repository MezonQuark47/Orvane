// Five North Loop wallet connection (Canton DevNet).
//
// Orvane's own contracts are not deployed on DevNet yet, so for now the wallet
// is used to identify the user and show their real Canton holdings. Once the
// DAR is live, the same DamlCommand objects built in shared/amm.ts can be sent
// through provider.submitTransaction unchanged.

import { loop } from '@fivenorth/loop-sdk'

export interface LoopHolding {
  symbol: string
  amount: number
  org: string
}

export interface LoopSession {
  party: string
  email?: string
  holdings: LoopHolding[]
}

type Provider = {
  party_id: string
  email?: string
  getHolding: () => Promise<Array<{ symbol: string; total_unlocked_coin: string; org_name: string }>>
}

let initialized = false
let resolveConnect: ((s: LoopSession) => void) | null = null
let rejectConnect: ((e: Error) => void) | null = null

function init() {
  if (initialized) return
  initialized = true
  loop.init({
    appName: 'Orvane',
    network: 'devnet',
    onAccept: async (provider: Provider) => {
      let holdings: LoopHolding[] = []
      try {
        const raw = await provider.getHolding()
        holdings = raw.map((h) => ({ symbol: h.symbol, amount: Number(h.total_unlocked_coin), org: h.org_name }))
      } catch {
        /* holdings are optional */
      }
      resolveConnect?.({ party: provider.party_id, email: provider.email, holdings })
    },
    onReject: () => rejectConnect?.(new Error('Connection rejected in Loop')),
  })
}

export function connectLoop(): Promise<LoopSession> {
  init()
  return new Promise((resolve, reject) => {
    resolveConnect = resolve
    rejectConnect = reject
    loop.connect()
  })
}
