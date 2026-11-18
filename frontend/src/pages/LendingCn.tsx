// Lending on LocalNet: borrow USDx against real Canton Coin. Every movement
// of funds is a CIP-56 allocation settled atomically by the operator.

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { HOLDING_V1, Scan, type HoldingView, type InstrumentId } from '../../../shared/amulet.ts'
import { LedgerError, type Contract } from '../../../shared/ledger.ts'
import { X, registries, sameInstrument, type ExchangePool } from '../../../shared/exchange.ts'
import {
  CR,
  borrowOrder,
  newRef,
  prepareAllocationArgs,
  repayOrder,
  supplyOrder,
  withdrawRequest,
  type CreditLoan,
  type CreditLoanClosed,
  type CreditMarket,
  type CreditPosition,
} from '../../../shared/credit.ts'
import { healthFactor, liquidationPrice, owedAt } from '../../../shared/lending.ts'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { pick, useNow, usePolled } from '../ledger/usePolled.ts'
import { EyeIcon, Panel, Rolling, Tilt, TokenGlyph, fmt, fmtCompact } from '../ui/bits.tsx'
import { HealthGauge, UtilRing } from './Lending.tsx'

const TEMPLATES = [CR.CreditMarket, CR.CreditPosition, CR.CreditLoan, CR.CreditLoanClosed, CR.CreditBorrowRequest, CR.CreditRepayRequest, CR.CreditSupplyRequest, CR.CreditWithdrawRequest, X.ExchangePool] as const
const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))
const pct = (bps: number) => `${fmt(bps / 100, 2)}%`

interface View {
  market?: Contract<CreditMarket>
  price: number // USDx per CC
  positions: Contract<CreditPosition>[]
  loans: Contract<CreditLoan>[]
  closed: Contract<CreditLoanClosed>[]
  pending: number
  balances: { usdx: number; cc: number }
}

function useBalances(usdx: InstrumentId, cc: InstrumentId) {
  const { ledger, party } = useOrvane()
  const [b, setB] = useState({ usdx: 0, cc: 0 })
  useEffect(() => {
    if (!party) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const hs = (await ledger.queryInterface<HoldingView>(party, HOLDING_V1)).filter((h) => h.view.owner === party && !h.view.lock)
        const sum = (i: InstrumentId) => hs.filter((h) => sameInstrument(h.view.instrumentId, i)).reduce((s, h) => s + +h.view.amount, 0)
        if (alive) setB({ usdx: sum(usdx), cc: sum(cc) })
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
  }, [ledger, party, usdx, cc])
  return b
}

export default function LendingCn() {
  const { config, party, persona } = useOrvane()
  const ex = config!.exchange!
  const rows = usePolled(TEMPLATES, 1300)
  const balances = useBalances(ex.usdx, ex.amulet)
  const market = pick<CreditMarket>(rows, 'CreditMarket').find((m) => m.payload.marketId === ex.creditMarketId)
  const pool = pick<ExchangePool>(rows, 'ExchangePool')[0]?.payload
  const price = pool ? (sameInstrument(pool.instrA, ex.usdx) ? +pool.reserveA / +pool.reserveB : +pool.reserveB / +pool.reserveA) : 0
  const v: View = {
    market,
    price,
    positions: pick<CreditPosition>(rows, 'CreditPosition').filter((p) => p.payload.owner === party),
    loans: pick<CreditLoan>(rows, 'CreditLoan').filter((l) => l.payload.borrower === party),
    closed: pick<CreditLoanClosed>(rows, 'CreditLoanClosed').filter((l) => l.payload.borrower === party),
    pending: ['CreditBorrowRequest', 'CreditRepayRequest', 'CreditSupplyRequest', 'CreditWithdrawRequest'].reduce((n, k) => n + pick(rows, k).length, 0),
    balances,
  }
  const m = market?.payload
  const cash = m ? +m.cash : 0
  const out = m ? +m.principalOut : 0
  const util = cash + out ? out / (cash + out) : 0
  const apr = m ? +m.baseAprBps + +m.slopeAprBps * util : 0

  return (
    <div className="page page-lending">
      <div className="narrative">
        <p className="eyebrow">Lending · USDx against {ex.realAmulet ? 'real Canton Coin' : 'test CC'} · CIP-56</p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Borrow against CC.
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>Quietly.</em>
          </motion.span>
        </h1>
        <p className="lede">
          Lock {ex.realAmulet ? 'real Canton Coin' : 'CC'}, receive USDx in the same atomic transaction. Repay, and your CC comes back the same way. If a loan turns unsafe,
          its CC is sold into the Orvane pool on-ledger. Members see totals; nobody sees who borrowed.
        </p>
        {m && (
          <motion.div className="market" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <UtilRing util={util} />
            <dl className="market-stats">
              <div>
                <dt>Supplied</dt>
                <dd className="mono">${fmtCompact(cash + out)}</dd>
              </div>
              <div>
                <dt>Borrowed</dt>
                <dd className="mono">${fmtCompact(out)}</dd>
              </div>
              <div>
                <dt>Borrow APR</dt>
                <dd className="mono">{pct(apr)}</dd>
              </div>
              <div>
                <dt>Supply APR</dt>
                <dd className="mono ok">{pct(apr * util)}</dd>
              </div>
              <div>
                <dt>Max LTV · liquidation</dt>
                <dd className="mono">
                  {fmt(+m.maxLtvBps / 100, 0)}% · {fmt(+m.liqLtvBps / 100, 0)}%
                </dd>
              </div>
              <div>
                <dt>CC price</dt>
                <dd className="mono">{fmt(price, 6)}</dd>
              </div>
            </dl>
          </motion.div>
        )}
        {m && +m.yearSeconds < 86_400 && (
          <p className="clock-chip">
            <span className="tick" /> Demo clock · one year of interest accrues every {fmt(+m.yearSeconds / 60, 0)} minutes
          </p>
        )}
      </div>
      <div className="rail">
        {persona?.key === 'auditor' ? (
          <Panel delay={0.1}>
            <p className="veil">
              <EyeIcon closed /> The auditor is not a member of the credit market and sees nothing here.
            </p>
          </Panel>
        ) : (
          <>
            {(v.loans.length > 0 || v.closed.length > 0) && <LoansCn v={v} />}
            <BorrowCn v={v} />
            <SupplyCn v={v} />
          </>
        )}
      </div>
    </div>
  )
}

function useSubmit() {
  const { config, ledger, party } = useOrvane()
  const ex = config!.exchange!
  return async (build: (reg: ReturnType<typeof registries>) => Promise<{ command: Parameters<typeof ledger.submit>[1][number]; disclosed: Parameters<typeof ledger.submit>[3] }>) => {
    const reg = registries(ledger, new Scan(''), ex.realAmulet ? ex.amulet.admin : '')
    const { command, disclosed } = await build(reg)
    await ledger.submit([party!], [command], [], disclosed)
  }
}

function BorrowCn({ v }: { v: View }) {
  const { config, ledger, party } = useOrvane()
  const ex = config!.exchange!
  const run = useSubmit()
  const [collRaw, setCollRaw] = useState('200000')
  const [ratio, setRatio] = useState(0.5)
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({})
  const m = v.market?.payload
  const coll = Number(collRaw) || 0
  const value = coll * v.price
  const max = m ? (value * +m.maxLtvBps) / 10_000 : 0
  const amount = Math.floor(max * ratio * 100) / 100
  const liq = m ? +m.liqLtvBps / 10_000 : 0.8
  const hf = healthFactor(value, liq, amount)
  const short = coll > v.balances.cc
  const noCash = m ? amount > +m.cash : true

  const go = async () => {
    setState({ busy: true })
    try {
      await run(async (reg) => {
        const prep = await prepareAllocationArgs({ ledger, reg, sender: party!, operator: config!.operator, instrument: ex.amulet, amount: coll, ref: newRef('borrow') })
        return { command: borrowOrder(party!, config!.operator, ex.creditMarketId!, prep.fields, amount), disclosed: prep.disclosed }
      })
      setState({ ok: 'CC locked. The operator is settling your loan…' })
    } catch (e) {
      setState({ error: errText(e) })
    }
  }

  return (
    <Panel delay={0.1}>
      <Tilt className="swap-card">
        <header className="card-head">
          <h2>Borrow</h2>
          <span className="badge">{ex.realAmulet ? 'real CC collateral' : 'CIP-56 collateral'}</span>
        </header>
        <div className="leg">
          <div className="leg-top">
            <span>Lock collateral</span>
            <button className="link" onClick={() => setCollRaw(String(Math.floor(v.balances.cc)))}>
              Balance {fmt(v.balances.cc, 0)} · Max
            </button>
          </div>
          <div className="leg-main">
            <input className="amount mono" inputMode="decimal" value={collRaw} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setCollRaw(e.target.value)} aria-label="Canton Coin collateral" />
            <span className="token-chip">
              <TokenGlyph symbol="CCx" /> CC
            </span>
          </div>
          <div className="muted small">
            ≈ ${fmt(value)} at {fmt(v.price, 6)}
          </div>
        </div>
        <div className="borrow-mid">
          <HealthGauge hf={hf} />
          <div className="borrow-amount">
            <span className="muted small">You borrow</span>
            <Rolling value={amount} className="mono big-ish" />
            <span className="muted small">USDx · max {fmt(max, 0)}</span>
            <input
              type="range"
              className="slider"
              min={0}
              max={1}
              step={0.01}
              value={ratio}
              onChange={(e) => setRatio(Number(e.target.value))}
              aria-label="Share of maximum borrow"
              style={{ '--fill': `${ratio * 100}%` } as React.CSSProperties}
            />
          </div>
        </div>
        <dl className="details">
          <div>
            <dt>Liquidation price</dt>
            <dd className="mono">{fmt(liquidationPrice(coll, liq, amount), 6)} USDx / CC</dd>
          </div>
          <div>
            <dt>Settlement</dt>
            <dd className="mono">CC in · USDx out · one transaction</dd>
          </div>
        </dl>
        <button className={`primary ${state.busy ? 'busy' : ''}`} disabled={!m || amount <= 0 || short || noCash || state.busy || v.pending > 0} onClick={go}>
          <span>{short ? 'Not enough CC' : noCash ? 'Market lacks cash' : state.busy || v.pending > 0 ? 'Settling…' : 'Lock CC & borrow'}</span>
        </button>
        {state.ok && v.pending > 0 && <p className="tx-ok">{state.ok}</p>}
        {state.error && <p className="tx-error">{state.error}</p>}
      </Tilt>
    </Panel>
  )
}

function LoansCn({ v }: { v: View }) {
  return (
    <Panel delay={0.15}>
      <header className="card-head">
        <h3>Your loans</h3>
        <span className="muted small">
          <EyeIcon /> you + operator
        </span>
      </header>
      <ul className="loan-list">
        <AnimatePresence initial={false}>
          {v.loans.map((l) => (
            <LoanCardCn key={l.contractId} loan={l} v={v} />
          ))}
        </AnimatePresence>
      </ul>
      {v.closed.length > 0 && (
        <>
          <h4 className="sub">Closed</h4>
          <ul className="mini-list">
            {v.closed.slice(0, 4).map((c) => (
              <li key={c.contractId}>
                <span className="mono">{fmt(+c.payload.principal)} USDx</span>
                <span className="mono small">paid {fmt(+c.payload.paid, 4)}</span>
                <span className={`tag ${c.payload.liquidated ? 'warn-tag' : 'tag-SwapReceipt'}`}>{c.payload.liquidated ? 'liquidated' : 'repaid · CC returned'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

function LoanCardCn({ loan, v }: { loan: Contract<CreditLoan>; v: View }) {
  const { config, ledger, party } = useOrvane()
  const ex = config!.exchange!
  const run = useSubmit()
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const m = v.market?.payload
  const l = loan.payload
  const owed = m ? owedAt(+m.yearSeconds, +l.principal, +l.aprBps, l.openedAt, now) : +l.principal
  const value = +l.collateralAmount * v.price
  const liq = m ? +m.liqLtvBps / 10_000 : 0.8
  const hf = healthFactor(value, liq, owed)
  // the settlement happens a moment after signing; cover ~2 minutes of interest
  const repayAmount = Math.ceil(owed * 1.0005 * 1e6) / 1e6

  const repay = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await run(async (reg) => {
        const prep = await prepareAllocationArgs({ ledger, reg, sender: party!, operator: config!.operator, instrument: ex.usdx, amount: repayAmount, ref: newRef('repay') })
        return { command: repayOrder(party!, config!.operator, loan.contractId, prep.fields), disclosed: prep.disclosed }
      })
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.li layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} className={hf < 1.1 ? 'at-risk' : ''}>
      <div className="loan-top">
        <HealthGauge hf={hf} size={118} />
        <div className="loan-nums">
          <span className="muted small">Owed now</span>
          <span className="mono owed">{fmt(owed, 4)}</span>
          <span className="muted small">
            USDx · {fmt(+l.principal)} at {pct(+l.aprBps)}
          </span>
        </div>
      </div>
      <dl className="details tight">
        <div>
          <dt>Collateral</dt>
          <dd className="mono">
            {fmt(+l.collateralAmount, 0)} CC ≈ ${fmt(value)}
          </dd>
        </div>
        <div>
          <dt>Liquidates below</dt>
          <dd className={`mono ${hf < 1.5 ? 'warn' : ''}`}>{fmt(liquidationPrice(+l.collateralAmount, liq, owed), 6)}</dd>
        </div>
      </dl>
      <div className="inv-actions">
        <button className="chip-btn" disabled={busy || v.pending > 0 || v.balances.usdx < repayAmount} onClick={repay}>
          {busy || v.pending > 0 ? 'Settling…' : `Repay ${fmt(repayAmount, 2)} & unlock CC`}
        </button>
      </div>
      {error && <p className="tx-error">{error}</p>}
    </motion.li>
  )
}

function SupplyCn({ v }: { v: View }) {
  const { config, ledger, party } = useOrvane()
  const ex = config!.exchange!
  const run = useSubmit()
  const [raw, setRaw] = useState('1000')
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})
  const m = v.market?.payload
  const amount = Number(raw) || 0
  const sv = m && +m.totalShares ? (+m.cash + +m.principalOut) / +m.totalShares : 1
  const myShares = v.positions.reduce((s, p) => s + +p.payload.shares, 0)

  const act = async (fn: () => Promise<void>) => {
    setState({ busy: true })
    try {
      await fn()
      setState({})
    } catch (e) {
      setState({ error: errText(e) })
    }
  }

  return (
    <Panel delay={0.2}>
      <header className="card-head">
        <h3>Supply USDx</h3>
        <span className="muted small ok">earns interest from CC-backed loans</span>
      </header>
      {myShares > 0 && (
        <div className="supply-pos">
          <span className="muted small">Your position</span>
          <div>
            <Rolling value={myShares * sv} className="mono big-ish" /> <span className="muted">USDx</span>
          </div>
          <span className="muted small mono">
            {fmt(myShares, 2)} shares × {fmt(sv, 6)}
          </span>
        </div>
      )}
      <div className="row-input">
        <input className="mono" inputMode="decimal" value={raw} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setRaw(e.target.value)} aria-label="USDx to supply" />
        <span className="muted small">USDx</span>
        <button
          className="chip-btn"
          disabled={state.busy || amount <= 0 || amount > v.balances.usdx || v.pending > 0}
          onClick={() =>
            act(() =>
              run(async (reg) => {
                const prep = await prepareAllocationArgs({ ledger, reg, sender: party!, operator: config!.operator, instrument: ex.usdx, amount, ref: newRef('supply') })
                return { command: supplyOrder(party!, config!.operator, ex.creditMarketId!, prep.fields), disclosed: prep.disclosed }
              }),
            )
          }
        >
          Supply
        </button>
        {v.positions[0] && (
          <button
            className="chip-btn ghosty"
            disabled={state.busy || v.pending > 0}
            onClick={() => act(() => ledger.submit([party!], v.positions.map((p) => withdrawRequest(party!, config!.operator, p.contractId))).then(() => undefined))}
          >
            Withdraw all
          </button>
        )}
      </div>
      {state.error && <p className="tx-error">{state.error}</p>}
    </Panel>
  )
}
