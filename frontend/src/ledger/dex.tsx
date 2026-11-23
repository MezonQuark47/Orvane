// Everything the app knows, in one place.
//
// Public data (pool terms, reserves, recent prices) comes from the
// operator's API, like any AMM's. The user's own contracts (holdings,
// positions, receipts, requests, incoming transfers) are read from their own
// node through their wallet, and only once they connect.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Contract } from '../../../shared/ledger.ts'
import { dec, ZERO, type Dec } from '../../../shared/decimal.ts'
import {
  ALLOCATION_V2,
  DEX,
  HOLDING_V2,
  TRANSFER_INSTRUCTION_V2,
  sameInstrument,
  type DepositRequest,
  type DisclosedContract,
  type InstrumentId,
  type LpPosition,
  type PoolTerms,
  type PositionClosed,
  type RenewRequest,
  type RequestRejected,
  type SwapReceipt,
  type SwapRequest,
  type WithdrawRequest,
} from '../../../shared/dex.ts'
import { HttpRegistry, type Registry } from '../../../shared/registry.ts'
import type { ExtensionWallet, WalletKind, WalletSession } from './wallet.ts'
import { NETWORK } from './network.ts'

export interface Instrument extends InstrumentId {
  key: string
  label: string
}

export interface PoolConfig extends PoolTerms {
  settlement: { executors: string[]; id: string; cid: null; meta: { values: Record<string, string> } }
  /** where wallets place orders; the operator's, so it travels as a disclosed contract */
  desk: DisclosedContract
}

export interface DexConfig {
  network: string
  operator: string
  instruments: Record<string, InstrumentId & { label: string }>
  pools: PoolConfig[]
}

export interface PricePoint {
  at: number
  price: number
  sizeA: number
}

export interface PoolLive {
  poolId: string
  reserveA: Dec
  reserveB: Dec
  positions: number
  status: 'Active' | 'Paused'
  swaps: number
  recent: PricePoint[]
}

export interface Holding {
  cid: string
  instrument: InstrumentId
  amount: Dec
  locked: boolean
}

export interface Incoming {
  cid: string
  instrument: InstrumentId
  amount: Dec
  sender: string | null
  receiver: string | null
  executeBefore: string
}

// One of the user's token-standard allocations: funds locked in their own
// account for a settlement.
export interface Allocation {
  cid: string
  admin: string
  settlementId: string
  executors: string[]
  committed: boolean
  deadline?: string
  funding: Record<string, string> | null
  counterparties: Array<string | null>
  settlements: number
}

export interface Mine {
  holdings: Holding[]
  positions: Contract<LpPosition>[]
  receipts: Contract<SwapReceipt>[]
  swaps: Contract<SwapRequest>[]
  deposits: Contract<DepositRequest>[]
  withdrawals: Contract<WithdrawRequest>[]
  renewals: Contract<RenewRequest>[]
  rejections: Contract<RequestRejected>[]
  closed: Contract<PositionClosed>[]
  incoming: Incoming[]
  /** transfers you sent that the receiver has not taken yet (e.g. a swap Cantex has not filled) */
  outgoing: Incoming[]
  allocations: Allocation[]
}

const EMPTY: Mine = { holdings: [], positions: [], receipts: [], swaps: [], deposits: [], withdrawals: [], renewals: [], rejections: [], closed: [], incoming: [], outgoing: [], allocations: [] }

export type WalletState = { phase: 'idle' } | { phase: 'connecting'; kind: WalletKind } | { phase: 'connected'; session: WalletSession } | { phase: 'error'; message: string }

export interface DexState {
  status: 'connecting' | 'ready' | 'offline'
  config?: DexConfig
  pools: Map<string, PoolLive>
  wallet: WalletState
  party?: string
  /** `extension` picks one browser-extension wallet when several are installed */
  connect: (kind: WalletKind, extension?: ExtensionWallet) => Promise<void>
  disconnect: () => Promise<void>
  mine: Mine
  /** the user's contracts have been read at least once since connecting */
  loaded: boolean
  refresh: () => Promise<void>
  submit: (commands: unknown[], disclosed?: DisclosedContract[], commandId?: string) => Promise<void>
  registry: (admin: string) => Registry
  instrument: (i: InstrumentId) => Instrument
  free: (i: InstrumentId) => Dec
  /** the newest read of the user's contracts, for waiting on settlement */
  latest: () => Mine
  /** a settled swap, deposit, withdrawal or renewal: makes the vault pulse */
  pulse: number
}

const Ctx = createContext<DexState | null>(null)
const POOL_MS = 2_500
const MINE_MS = 2_000
const WALLET_KEY = 'orvane.wallet'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return (await res.json()) as T
}

interface PoolWire {
  poolId: string
  reserveA: string
  reserveB: string
  positions: number
  status: 'Active' | 'Paused'
  swaps: number
  recent: Array<{ at: string; price: number; sizeA: number }>
}

interface HoldingWire {
  account: { owner: string | null }
  instrumentId: InstrumentId
  amount: string
  lock: unknown
}

interface AllocationWire {
  settlement: { id: string; executors: string[] }
  allocation: {
    admin: string
    committed: boolean
    settlementDeadline: string | null
    nextIterationFunding: Record<string, string> | null
    transferLegSides: Array<{ otherside: { owner: string | null } }>
  }
  numIterations: string
}

interface InstructionWire {
  transfer: { sender: { owner: string | null }; receiver: { owner: string | null }; amount: string; instrumentId: InstrumentId; executeBefore: string }
}

export function DexProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DexState['status']>('connecting')
  const [config, setConfig] = useState<DexConfig>()
  const [pools, setPools] = useState<Map<string, PoolLive>>(new Map())
  const [wallet, setWallet] = useState<WalletState>({ phase: 'idle' })
  const [mine, setMine] = useState<Mine>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [pulse, setPulse] = useState(0)
  const session = wallet.phase === 'connected' ? wallet.session : undefined
  const mineRef = useRef<Mine>(EMPTY)
  mineRef.current = mine
  const latest = useCallback(() => mineRef.current, [])
  const party = session?.party

  // ---- public: the Orvane pool's config and state (pool networks only) ----
  useEffect(() => {
    if (!NETWORK.pool) {
      setStatus('ready')
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    let lastSwaps = -1
    const tick = async () => {
      try {
        const [cfg, ps] = await Promise.all([config ? Promise.resolve(config) : getJson<DexConfig>('/api/config'), getJson<PoolWire[]>('/api/pools')])
        if (!alive) return
        if (!config) setConfig(cfg)
        const map = new Map(
          ps.map((p) => [
            p.poolId,
            { ...p, reserveA: dec(p.reserveA), reserveB: dec(p.reserveB), recent: p.recent.map((r) => ({ ...r, at: Date.parse(r.at) })) },
          ]),
        )
        const swaps = ps.reduce((s, p) => s + p.swaps, 0)
        if (lastSwaps >= 0 && swaps > lastSwaps) setPulse((n) => n + 1)
        lastSwaps = swaps
        setPools(map)
        setStatus('ready')
      } catch {
        if (alive) setStatus('offline')
      }
      if (alive) timer = setTimeout(tick, POOL_MS)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [config])

  // ---- wallet ----
  const connect = useCallback(
    async (kind: WalletKind, extension?: ExtensionWallet) => {
      setWallet({ phase: 'connecting', kind })
      try {
        // the wallet SDKs are large; load them only when someone connects
        const w = await import('./wallet.ts')
        const s =
          kind === 'gateway'
            ? await w.connectGateway()
            : kind === 'extension'
              ? await w.connectExtension(extension)
              : await w.connectLoop(NETWORK.loop ?? 'testnet')
        setWallet({ phase: 'connected', session: s })
        try {
          // an extension is remembered by its id, so the same one comes back
          localStorage.setItem(WALLET_KEY, extension ? `extension:${extension.id}` : kind)
        } catch {
          /* storage blocked: the user reconnects next time */
        }
      } catch (e) {
        setWallet({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
        throw e
      }
    },
    [],
  )

  const disconnect = useCallback(async () => {
    const s = wallet.phase === 'connected' ? wallet.session : undefined
    setWallet({ phase: 'idle' })
    setMine(EMPTY)
    setLoaded(false)
    try {
      localStorage.removeItem(WALLET_KEY)
    } catch {
      /* nothing to forget */
    }
    await s?.disconnect().catch(() => {})
  }, [wallet])

  // reconnect quietly to the wallet used last time
  const tried = useRef(false)
  useEffect(() => {
    if (tried.current || status !== 'ready') return
    tried.current = true
    let kind: string | null = null
    try {
      kind = localStorage.getItem(WALLET_KEY)
    } catch {
      /* no storage */
    }
    if (kind === 'gateway' || kind === 'loop' || kind === 'extension') connect(kind).catch(() => setWallet({ phase: 'idle' }))
    else if (kind?.startsWith('extension:')) {
      const id = kind.slice('extension:'.length)
      import('./wallet.ts')
        .then((w) => w.extensionWallets())
        .then((found) => {
          const ext = found.find((x) => x.id === id)
          if (ext) return connect('extension', ext)
        })
        .catch(() => setWallet({ phase: 'idle' }))
    }
  }, [status, connect])

  // ---- the user's own contracts ----
  const read = useCallback(async (): Promise<Mine | undefined> => {
    if (!session) return undefined
    const { ledger, party } = session
    // a query the user's node cannot answer (say, the pool package is not
    // there) must not hide the rest
    const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[])
    const [rows, holdings, instructions, allocations] = await Promise.all([
      NETWORK.pool ? safe(ledger.query<unknown>(party, [
        DEX.LpPosition,
        DEX.SwapReceipt,
        DEX.SwapRequest,
        DEX.DepositRequest,
        DEX.WithdrawRequest,
        DEX.RenewRequest,
        DEX.RequestRejected,
        DEX.PositionClosed,
      ])) : Promise.resolve([] as Contract<unknown>[]),
      // a wallet that reports balances itself (Loop) is asked directly; it
      // knows its own tokens best
      session.balances
        ? session.balances().then(
            (bs) =>
              bs.flatMap((b, n) => [
                { contractId: `wallet:${n}:free`, templateId: '', view: { account: { owner: party }, instrumentId: b.instrument, amount: b.free, lock: null } },
                { contractId: `wallet:${n}:locked`, templateId: '', view: { account: { owner: party }, instrumentId: b.instrument, amount: b.locked, lock: {} } },
              ]),
            () => ledger.queryInterface<HoldingWire>(party, HOLDING_V2),
          )
        : ledger.queryInterface<HoldingWire>(party, HOLDING_V2),
      safe(ledger.queryInterface<InstructionWire>(party, TRANSFER_INSTRUCTION_V2)),
      safe(ledger.queryInterface<AllocationWire>(party, ALLOCATION_V2)),
    ])
    const transferOf = (i: { contractId: string; view: InstructionWire }) => ({
      cid: i.contractId,
      instrument: i.view.transfer.instrumentId,
      amount: dec(i.view.transfer.amount),
      sender: i.view.transfer.sender.owner,
      receiver: i.view.transfer.receiver.owner,
      executeBefore: i.view.transfer.executeBefore,
    })
    const of = <T,>(entity: string) => rows.filter((c) => c.templateId.endsWith(`:${entity}`)) as Contract<T>[]
    const newest = <T,>(xs: Contract<T>[]) => [...xs].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    return {
      holdings: holdings
        .filter((h) => h.view.account.owner === party && Number(h.view.amount) > 0)
        .map((h) => ({ cid: h.contractId, instrument: h.view.instrumentId, amount: dec(h.view.amount), locked: !!h.view.lock })),
      positions: of<LpPosition>('LpPosition').filter((p) => p.payload.provider === party),
      receipts: newest(of<SwapReceipt>('SwapReceipt').filter((r) => r.payload.trader === party)),
      swaps: of<SwapRequest>('SwapRequest').filter((r) => r.payload.trader === party),
      deposits: of<DepositRequest>('DepositRequest').filter((r) => r.payload.provider === party),
      withdrawals: of<WithdrawRequest>('WithdrawRequest').filter((r) => r.payload.provider === party),
      renewals: of<RenewRequest>('RenewRequest').filter((r) => r.payload.provider === party),
      rejections: newest(of<RequestRejected>('RequestRejected').filter((r) => r.payload.party === party)),
      closed: newest(of<PositionClosed>('PositionClosed').filter((r) => r.payload.provider === party)),
      incoming: instructions.filter((i) => i.view.transfer.receiver.owner === party).map(transferOf),
      outgoing: instructions.filter((i) => i.view.transfer.sender.owner === party && i.view.transfer.receiver.owner !== party).map(transferOf),
      allocations: allocations.map((a) => ({
        cid: a.contractId,
        admin: a.view.allocation.admin,
        settlementId: a.view.settlement.id,
        executors: a.view.settlement.executors,
        committed: a.view.allocation.committed,
        deadline: a.view.allocation.settlementDeadline ?? undefined,
        funding: a.view.allocation.nextIterationFunding,
        counterparties: a.view.allocation.transferLegSides.map((s) => s.otherside.owner),
        settlements: Number(a.view.numIterations),
      })),
    }
  }, [session])

  const refresh = useCallback(async () => {
    const m = await read()
    if (m) {
      setMine((prev) => {
        if (prev.receipts.length < m.receipts.length || prev.closed.length < m.closed.length) setPulse((n) => n + 1)
        return m
      })
      setLoaded(true)
    }
  }, [read])

  useEffect(() => {
    setMine(EMPTY)
    setLoaded(false)
    if (!session) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        if (alive) await refresh()
      } catch {
        /* the wallet or node is busy; keep the last read */
      }
      if (alive) timer = setTimeout(tick, MINE_MS)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [session, refresh])

  const submit = useCallback(
    async (commands: unknown[], disclosed: DisclosedContract[] = [], commandId?: string) => {
      if (!session) throw new Error('Connect a wallet first')
      await session.submit(commands, disclosed, commandId)
      refresh().catch(() => {})
    },
    [session, refresh],
  )

  const registries = useRef(new Map<string, Registry>())
  const registry = useCallback((admin: string) => {
    let r = registries.current.get(admin)
    if (!r) {
      r = new HttpRegistry('', admin)
      registries.current.set(admin, r)
    }
    return r
  }, [])

  const instrument = useCallback(
    (i: InstrumentId): Instrument => {
      const entry = Object.entries(config?.instruments ?? {}).find(([, x]) => sameInstrument(x, i))
      return { ...i, key: entry?.[0] ?? i.id, label: entry?.[0] ?? i.id }
    },
    [config],
  )

  const free = useCallback(
    (i: InstrumentId) => mine.holdings.filter((h) => !h.locked && sameInstrument(h.instrument, i)).reduce((s, h) => s + h.amount, ZERO),
    [mine.holdings],
  )

  const value = useMemo<DexState>(
    () => ({ status, config, pools, wallet, party, connect, disconnect, mine, loaded, refresh, submit, registry, instrument, free, latest, pulse }),
    [status, config, pools, wallet, party, connect, disconnect, mine, loaded, refresh, submit, registry, instrument, free, latest, pulse],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDex() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDex outside DexProvider')
  return v
}

// Poll until `probe` finds something, or give up after `ms`.
export async function waitFor<T>(probe: () => T | undefined, ms = 60_000, every = 700): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = probe()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('not settled yet')
    await new Promise((r) => setTimeout(r, every))
  }
}
