import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { JsonLedger, LedgerError, type Contract, type DamlCommand } from '../../../shared/ledger.ts'
import {
  T,
  placeLiquidity,
  placeSwap,
  requestWithdraw,
  type LpShare,
  type Pool,
  type SwapReceipt,
  type SwapRequest,
  type Token,
} from '../../../shared/amm.ts'

export interface Persona {
  key: string
  name: string
  role: string
  party: string
  group: 'market' | 'business'
}

export interface Config {
  poolId: string
  marketId: string
  network?: 'sandbox' | 'localnet'
  operator: string
  issuers: { USDx: string; CCx: string }
  business: { employer: string; supplier: string; auditor: string; employees: string[] }
  personas: Persona[]
}

export interface PricePoint {
  at: number
  price: number // USDx per CCx
  reserveA: number
  reserveB: number
}

export type Symbol = 'USDx' | 'CCx'

export interface Balances {
  USDx: number
  CCx: number
}

export interface PoolView {
  cid: string
  reserveA: number
  reserveB: number
  totalShares: number
  feeBps: number
  price: number
}

export type TxPhase = 'idle' | 'signing' | 'settling' | 'done' | 'error'

export interface TxState {
  phase: TxPhase
  kind?: 'swap' | 'deposit' | 'withdraw'
  message?: string
  receipt?: SwapReceipt
}

interface OrvaneState {
  status: 'connecting' | 'ready' | 'offline'
  config?: Config
  persona?: Persona
  setPersona: (key: string) => void
  party?: string
  tokens: Contract<Token>[]
  balances: Balances
  pool?: PoolView
  lpShares: Contract<LpShare>[]
  receipts: Contract<SwapReceipt>[]
  history: PricePoint[]
  tx: TxState
  resetTx: () => void
  swap: (from: Symbol, amount: number, minOutput: number) => Promise<void>
  deposit: (amountA: number, amountB: number) => Promise<void>
  withdraw: (lp: Contract<LpShare>) => Promise<void>
  faucet: () => Promise<void>
  pulse: { id: number; from: Symbol } | null
  ledger: JsonLedger
  // Submit commands as the current persona.
  submit: (commands: DamlCommand[]) => Promise<void>
  holdingsFor: (sym: Symbol) => string[]
  refresh: () => Promise<void>
}

const Ctx = createContext<OrvaneState | null>(null)

// The dev proxy authenticates as ledger user "orvane" on LocalNet; commands
// must carry the same user id. On the sandbox the user id is not checked.
const ledger = new JsonLedger('', 'orvane')
const POLL_MS = 1200

const num = (s: string) => Number(s)

export function OrvaneProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OrvaneState['status']>('connecting')
  const [config, setConfig] = useState<Config>()
  const [personaKey, setPersonaKey] = useState<string>(() => {
    try {
      return localStorage.getItem('orvane.persona') ?? 'bob'
    } catch {
      return 'bob'
    }
  })
  const [tokens, setTokens] = useState<Contract<Token>[]>([])
  const [poolC, setPoolC] = useState<Contract<Pool>>()
  const [lpShares, setLpShares] = useState<Contract<LpShare>[]>([])
  const [receipts, setReceipts] = useState<Contract<SwapReceipt>[]>([])
  const [pending, setPending] = useState<Contract<SwapRequest>[]>([])
  const [history, setHistory] = useState<PricePoint[]>([])
  const [tx, setTx] = useState<TxState>({ phase: 'idle' })
  const [pulse, setPulse] = useState<OrvaneState['pulse']>(null)
  const settleWatch = useRef<{ kind: TxState['kind']; receiptsBefore: Set<string>; lpBefore: Set<string>; since: number } | null>(null)

  // ---- config ----
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/config')
        if (!res.ok) throw new Error(String(res.status))
        const cfg = (await res.json()) as Config
        if (alive) {
          setConfig(cfg)
          setStatus('ready')
        }
      } catch {
        if (alive) {
          setStatus('offline')
          setTimeout(load, 3000)
        }
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [])

  const persona = config?.personas.find((p) => p.key === personaKey) ?? config?.personas[1]
  const party = persona?.party

  const setPersona = useCallback((key: string) => {
    setPersonaKey(key)
    setTx({ phase: 'idle' })
    try {
      localStorage.setItem('orvane.persona', key)
    } catch {
      /* storage unavailable */
    }
  }, [])

  // ---- polling ----
  const refresh = useCallback(async () => {
    if (!party || !config) return
    const [toks, pools, lps, rcs, reqs] = await Promise.all([
      ledger.query<Token>(party, [T.Token]),
      ledger.query<Pool>(party, [T.Pool]),
      ledger.query<LpShare>(party, [T.LpShare]),
      ledger.query<SwapReceipt>(party, [T.SwapReceipt]),
      ledger.query<SwapRequest>(party, [T.SwapRequest]),
    ])
    setTokens(toks.filter((t) => t.payload.owner === party))
    setPoolC(pools.find((p) => p.payload.poolId === config.poolId))
    setLpShares(lps.filter((l) => l.payload.owner === party))
    setReceipts(rcs.filter((r) => r.payload.trader === party).reverse())
    setPending(reqs.filter((r) => r.payload.trader === party))
  }, [party, config])

  useEffect(() => {
    setTokens([])
    setLpShares([])
    setReceipts([])
    if (!party) return
    let alive = true
    const tick = async () => {
      try {
        await refresh()
        if (alive && status === 'offline') setStatus('ready')
      } catch {
        /* sandbox restarting; keep polling */
      }
      if (alive) timer = setTimeout(tick, POLL_MS)
    }
    let timer = setTimeout(tick, 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [party, refresh, status])

  // Price history: every Pool version this party has seen.
  useEffect(() => {
    if (!party) return
    let alive = true
    const load = async () => {
      try {
        const h = await ledger.history(party, [T.Pool])
        if (!alive) return
        setHistory(
          h
            .map(({ at, event }) => {
              const p = event.createArgument as Pool
              const a = num(p.reserveA)
              const b = num(p.reserveB)
              return { at: Date.parse(at), price: b > 0 ? a / b : 0, reserveA: a, reserveB: b }
            })
            .filter((p) => p.price > 0),
        )
      } catch {
        /* ignore */
      }
    }
    load()
    const id = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [party, poolC?.contractId])

  // ---- derived ----
  const balances = useMemo<Balances>(() => {
    const b = { USDx: 0, CCx: 0 }
    for (const t of tokens) {
      if (t.payload.symbol === 'USDx' && t.payload.issuer === config?.issuers.USDx) b.USDx += num(t.payload.amount)
      if (t.payload.symbol === 'CCx' && t.payload.issuer === config?.issuers.CCx) b.CCx += num(t.payload.amount)
    }
    return b
  }, [tokens, config])

  const pool = useMemo<PoolView | undefined>(() => {
    if (!poolC) return undefined
    const p = poolC.payload
    const a = num(p.reserveA)
    const b = num(p.reserveB)
    return { cid: poolC.contractId, reserveA: a, reserveB: b, totalShares: num(p.totalShares), feeBps: num(p.feeBps), price: b ? a / b : 0 }
  }, [poolC])

  // Settlement watcher: the operator settles asynchronously. We're done when a
  // new receipt/LP share shows up, or failed when the request disappears without one.
  useEffect(() => {
    const w = settleWatch.current
    if (!w || tx.phase !== 'settling') return
    if (w.kind === 'swap') {
      const fresh = receipts.find((r) => !w.receiptsBefore.has(r.contractId))
      if (fresh) {
        settleWatch.current = null
        setTx({ phase: 'done', kind: 'swap', receipt: fresh.payload })
        setPulse({ id: Date.now(), from: fresh.payload.symbolIn as Symbol })
        return
      }
      if (pending.length === 0 && Date.now() - w.since > 2500) {
        settleWatch.current = null
        setTx({ phase: 'error', kind: 'swap', message: 'The price moved past your slippage limit. Nothing was spent.' })
      }
    } else {
      const changed =
        lpShares.some((l) => !w.lpBefore.has(l.contractId)) || lpShares.length !== w.lpBefore.size
      if (changed) {
        settleWatch.current = null
        setTx({ phase: 'done', kind: w.kind })
        setPulse({ id: Date.now(), from: 'USDx' })
      } else if (Date.now() - w.since > 15000) {
        settleWatch.current = null
        setTx({ phase: 'error', kind: w.kind, message: 'The operator did not settle this request.' })
      }
    }
  }, [receipts, pending, lpShares, tx.phase])

  const run = useCallback(
    async (kind: NonNullable<TxState['kind']>, fn: () => Promise<unknown>) => {
      setTx({ phase: 'signing', kind })
      try {
        settleWatch.current = {
          kind,
          receiptsBefore: new Set(receipts.map((r) => r.contractId)),
          lpBefore: new Set(lpShares.map((l) => l.contractId)),
          since: Date.now(),
        }
        await fn()
        setTx({ phase: 'settling', kind })
        await refresh()
      } catch (err) {
        settleWatch.current = null
        setTx({ phase: 'error', kind, message: err instanceof LedgerError ? err.message : String(err) })
      }
    },
    [receipts, lpShares, refresh],
  )

  const holdingsFor = useCallback(
    (sym: Symbol) =>
      tokens.filter((t) => t.payload.symbol === sym && t.payload.issuer === config?.issuers[sym]).map((t) => t.contractId),
    [tokens, config],
  )

  const swap = useCallback(
    (from: Symbol, amount: number, minOutput: number) =>
      run('swap', () =>
        ledger.submit([party!], [
          placeSwap({ trader: party!, operator: config!.operator, poolId: config!.poolId, holdings: holdingsFor(from), amount, minOutput }),
        ]),
      ),
    [run, party, config, holdingsFor],
  )

  const deposit = useCallback(
    (amountA: number, amountB: number) =>
      run('deposit', () =>
        ledger.submit([party!], [
          placeLiquidity({
            provider: party!,
            operator: config!.operator,
            poolId: config!.poolId,
            holdingsA: holdingsFor('USDx'),
            amountA,
            holdingsB: holdingsFor('CCx'),
            amountB,
            minShares: 0,
          }),
        ]),
      ),
    [run, party, config, holdingsFor],
  )

  const withdraw = useCallback(
    (lp: Contract<LpShare>) =>
      run('withdraw', () =>
        ledger.submit([party!], [requestWithdraw({ provider: party!, operator: config!.operator, lpCid: lp.contractId, minA: 0, minB: 0 })]),
      ),
    [run, party, config],
  )

  const faucet = useCallback(async () => {
    if (!party) return
    await fetch('/api/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ party }) })
    await refresh()
  }, [party, refresh])

  const value: OrvaneState = {
    status,
    config,
    persona,
    setPersona,
    party,
    tokens,
    balances,
    pool,
    lpShares,
    receipts,
    history,
    tx,
    resetTx: () => setTx({ phase: 'idle' }),
    swap,
    deposit,
    withdraw,
    faucet,
    pulse,
    ledger,
    submit: async (commands) => {
      await ledger.submit([party!], commands)
      await refresh()
    },
    holdingsFor,
    refresh,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useOrvane() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useOrvane outside OrvaneProvider')
  return v
}
