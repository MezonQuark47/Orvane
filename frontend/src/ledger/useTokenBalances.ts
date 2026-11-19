import { useEffect, useState } from 'react'
import { HOLDING_V1, type HoldingView, type InstrumentId } from '../../../shared/amulet.ts'
import { sameInstrument } from '../../../shared/exchange.ts'
import { useOrvane } from './OrvaneProvider.tsx'

export type Held = { contractId: string; view: HoldingView }

// Spendable CIP-56 balances of the current persona, read through the
// standard Holding interface (locked holdings don't count), plus the
// holding contracts themselves.
export function useTokenBalances(usdx: InstrumentId, cc: InstrumentId, enabled = true) {
  const { ledger, party } = useOrvane()
  const [b, setB] = useState<{ usdx: number; cc: number; holdings: Held[]; loadedFor?: string }>({ usdx: 0, cc: 0, holdings: [] })
  useEffect(() => {
    if (!party || !enabled) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const mine = (await ledger.queryInterface<HoldingView>(party, HOLDING_V1)).filter((h) => h.view.owner === party)
        const free = mine.filter((h) => !h.view.lock)
        const sum = (i: InstrumentId) => free.filter((h) => sameInstrument(h.view.instrumentId, i)).reduce((s, h) => s + +h.view.amount, 0)
        if (alive) setB({ usdx: sum(usdx), cc: sum(cc), holdings: mine, loadedFor: party })
      } catch {
        /* keep last */
      }
      if (alive) timer = setTimeout(tick, 1500)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ledger, party, usdx, cc, enabled])
  return { usdx: b.usdx, cc: b.cc, holdings: b.holdings, loaded: !!party && b.loadedFor === party }
}
