// Market data from the swap venue: what can be swapped and the pools behind
// it. Cantex (TestNet, MainNet) also streams live prices and candles, read
// straight from its public API; OneSwap (DevNet) has pools and quotes only.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CantexApi, streamMarket, sameInstrument, type Candle, type ExchangePolicy, type Instrument, type PoolState, type SwapVenue, type Token } from '../../../shared/cantex.ts'
import { OneSwapApi } from '../../../shared/oneswap.ts'
import { NETWORK } from '../ledger/network.ts'

export interface MarketState {
  status: 'loading' | 'ready' | 'offline' | 'unsupported'
  api?: SwapVenue
  tokens: Token[]
  pools: PoolState[]
  policy?: ExchangePolicy
  /** Canton Coin on this network */
  cc?: Token
  /** last price per market symbol, e.g. "CC-USDCX" or the reference "CC-USDC" */
  prices: Record<string, { price: number; at: number }>
  candles: Record<string, Candle[]>
  /** subscribe to a market's candles for as long as a chart is on screen */
  watchCandles: (symbol: string, period: number) => () => void
  token: (i: Instrument) => Token | undefined
  /** the pool trading two instruments directly, if Cantex has one */
  poolFor: (a: Instrument, b: Instrument) => PoolState | undefined
  refresh: () => Promise<void>
}

const Ctx = createContext<MarketState | null>(null)
const REFRESH_MS = 15_000

export function MarketProvider({ children }: { children: ReactNode }) {
  const cfg = NETWORK.cantex
  const api = useMemo<SwapVenue | undefined>(
    () => (cfg ? new CantexApi(cfg.api) : NETWORK.oneswap ? new OneSwapApi(NETWORK.oneswap.api) : undefined),
    [cfg],
  )
  const [status, setStatus] = useState<MarketState['status']>(api ? 'loading' : 'unsupported')
  const [tokens, setTokens] = useState<Token[]>([])
  const [pools, setPools] = useState<PoolState[]>([])
  const [policy, setPolicy] = useState<ExchangePolicy>()
  const [prices, setPrices] = useState<MarketState['prices']>({})
  const [candles, setCandles] = useState<MarketState['candles']>({})

  const refresh = useCallback(async () => {
    if (!api) return
    const [t, p, pol] = await Promise.all([api.swapTokens(), api.pools(), api.policy()])
    setTokens(t)
    setPools(p)
    setPolicy(pol)
    setStatus('ready')
  }, [api])

  useEffect(() => {
    if (!api) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        await refresh()
      } catch {
        if (alive) setStatus((s) => (s === 'ready' ? s : 'offline'))
      }
      if (alive) timer = setTimeout(tick, REFRESH_MS)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, refresh])

  // live prices for every pool and the outside reference market
  const symbols = useMemo(() => [...new Set([...pools.map((p) => p.symbol), ...(cfg ? [cfg.referenceMarket] : [])])].sort(), [pools, cfg])
  const symbolKey = symbols.join(',')
  useEffect(() => {
    if (!cfg || !symbolKey) return
    return streamMarket(cfg.ws, symbolKey.split(',').map((s) => `market.${s}.ticker`), {
      onTicker: (t) => setPrices((p) => ({ ...p, [t.symbol]: { price: t.price, at: t.at } })),
    })
  }, [cfg, symbolKey])

  // candle subscriptions are reference-counted so charts can come and go
  const watchers = useRef(new Map<string, { count: number; close: () => void }>())
  const watchCandles = useCallback(
    (symbol: string, period: number) => {
      if (!cfg) return () => {}
      const key = `${symbol}:${period}`
      const w = watchers.current.get(key)
      if (w) w.count++
      else {
        const close = streamMarket(cfg.ws, [`market.${symbol}.candles.${period}`], {
          onCandles: (_, __, bars, snapshot) =>
            setCandles((c) => {
              if (snapshot) return { ...c, [key]: bars }
              const merged = new Map((c[key] ?? []).map((b) => [b.start, b]))
              for (const b of bars) merged.set(b.start, b)
              return { ...c, [key]: [...merged.values()].sort((a, b) => a.start - b.start).slice(-300) }
            }),
        })
        watchers.current.set(key, { count: 1, close })
      }
      return () => {
        const cur = watchers.current.get(key)
        if (!cur) return
        if (--cur.count <= 0) {
          cur.close()
          watchers.current.delete(key)
        }
      }
    },
    [cfg],
  )

  const token = useCallback((i: Instrument) => tokens.find((t) => sameInstrument(t, i)), [tokens])
  const poolFor = useCallback(
    (a: Instrument, b: Instrument) => pools.find((p) => (sameInstrument(p.a, a) && sameInstrument(p.b, b)) || (sameInstrument(p.a, b) && sameInstrument(p.b, a))),
    [pools],
  )
  const cc = tokens.find((t) => t.symbol === 'CC' && t.id === 'Amulet')

  const value = useMemo<MarketState>(
    () => ({ status, api, tokens, pools, policy, cc, prices, candles, watchCandles, token, poolFor, refresh }),
    [status, api, tokens, pools, policy, cc, prices, candles, watchCandles, token, poolFor, refresh],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMarket() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useMarket outside MarketProvider')
  return v
}
