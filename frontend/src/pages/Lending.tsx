import { VaultStage } from '../three/stage.tsx'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { type Contract } from '../../../shared/ledger.ts'
import {
  L,
  addCollateral,
  borrow,
  borrowAprBps,
  healthFactor,
  liquidationPrice,
  marketView,
  owedAt,
  repayLoan,
  requestAdvance,
  setAdvanceLimit,
  shareValue,
  supply,
  supplyAprBps,
  utilization,
  withdrawSupply,
  type Advance,
  type AdvanceLine,
  type LendingMarket,
  type Loan,
  type LoanClosed,
  type MarketView,
  type SupplyPosition,
} from '../../../shared/lending.ts'
import { useOrvane, type Config } from '../ledger/OrvaneProvider.tsx'
import { pick, useNow, usePolled } from '../ledger/usePolled.ts'
import { EyeIcon, Panel, Rolling, Tilt, TokenGlyph, fmt, fmtCompact } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'

const TEMPLATES = [L.LendingMarket, L.SupplyPosition, L.Loan, L.LoanClosed, L.AdvanceLine, L.Advance, L.BorrowRequest, L.SupplyRequest, L.AdvanceRequest] as const

const pct = (bps: number) => `${fmt(bps / 100, 2)}%`

interface Ctx {
  market?: Contract<LendingMarket>
  m?: MarketView
  price: number
  positions: Contract<SupplyPosition>[]
  loans: Contract<Loan>[]
  closed: Contract<LoanClosed>[]
  lines: Contract<AdvanceLine>[]
  advances: Contract<Advance>[]
  pending: number
  config: Config
}

export default function Lending() {
  const { config, party, persona, pool } = useOrvane()
  const rows = usePolled(TEMPLATES)
  if (!config || !party || !persona) return null
  const market = pick<LendingMarket>(rows, 'LendingMarket')[0]
  const ctx: Ctx = {
    market,
    m: market ? marketView(market.payload) : undefined,
    price: pool?.price ?? 0,
    positions: pick<SupplyPosition>(rows, 'SupplyPosition').filter((p) => p.payload.owner === party),
    loans: pick<Loan>(rows, 'Loan').filter((l) => l.payload.borrower === party),
    closed: pick<LoanClosed>(rows, 'LoanClosed').filter((l) => l.payload.borrower === party),
    lines: pick<AdvanceLine>(rows, 'AdvanceLine'),
    advances: pick<Advance>(rows, 'Advance'),
    pending: pick(rows, 'BorrowRequest').length + pick(rows, 'SupplyRequest').length + pick(rows, 'AdvanceRequest').length,
    config,
  }
  const key = persona.key
  const myLine = ctx.lines.find((l) => l.payload.employee === party)

  if (key === 'auditor') {
    return (
      <div className="page page-lending">
        <Narrative ctx={ctx} />
        <div className="rail">
          <Panel delay={0.1}>
            <p className="veil">
              <EyeIcon closed /> The auditor is not a member of the lending market and sees nothing here.
            </p>
          </Panel>
        </div>
      </div>
    )
  }

  const cards: Record<string, React.ReactNode> = {
    loans: ctx.loans.length || ctx.closed.length ? <Loans key="loans" ctx={ctx} /> : null,
    borrow: <BorrowCard key="borrow" ctx={ctx} />,
    supply: <SupplyCard key="supply" ctx={ctx} />,
    advance: myLine ? <AdvanceCard key="advance" ctx={ctx} line={myLine} /> : null,
    lines: key === 'acme' ? <AdvanceLines key="lines" ctx={ctx} /> : null,
  }
  const order: Record<string, string[]> = {
    alice: ['supply', 'advance', 'loans', 'borrow'],
    bob: ['advance', 'loans', 'borrow', 'supply'],
    carol: ['advance', 'supply', 'loans', 'borrow'],
    acme: ['loans', 'borrow', 'lines', 'supply'],
    nova: ['loans', 'borrow', 'supply'],
  }

  return (
    <div className="page page-lending">
      <Narrative ctx={ctx} />
      <div className="rail">{(order[key] ?? order.nova).map((k) => cards[k])}</div>
    </div>
  )
}

// ---------- narrative + market ----------

function Narrative({ ctx }: { ctx: Ctx }) {
  const m = ctx.m
  const util = m ? utilization(m) : 0
  return (
    <div className="narrative">
      <VaultStage scene="lending" lift={(util - 0.5) * 0.9} />
      <p className="eyebrow">Lending · USDx against CCx</p>
      <h1 className="display">
        <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
          Borrow against it.
        </motion.span>
        <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
          <em>Quietly.</em>
        </motion.span>
      </h1>
      <p className="lede">
        Lock CCx, borrow USDx, priced live by the Orvane pool. If a loan turns unsafe, its collateral is sold through the pool in the same
        transaction that repays lenders. Members see the market's totals. Nobody sees who borrowed.
      </p>
      {m && (
        <motion.div className="market" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <UtilRing util={util} />
          <dl className="market-stats">
            <div>
              <dt>Supplied</dt>
              <dd className="mono">${fmtCompact(m.cash + m.principalOut)}</dd>
            </div>
            <div>
              <dt>Borrowed</dt>
              <dd className="mono">${fmtCompact(m.principalOut)}</dd>
            </div>
            <div>
              <dt>Borrow APR</dt>
              <dd className="mono">{pct(borrowAprBps(m))}</dd>
            </div>
            <div>
              <dt>Supply APR</dt>
              <dd className="mono ok">{pct(supplyAprBps(m))}</dd>
            </div>
            <div>
              <dt>Max LTV · liquidation</dt>
              <dd className="mono">
                {fmt(m.maxLtv * 100, 0)}% · {fmt(m.liqLtv * 100, 0)}%
              </dd>
            </div>
            <div>
              <dt>CCx price</dt>
              <dd className="mono">{fmt(ctx.price, 5)}</dd>
            </div>
          </dl>
        </motion.div>
      )}
      {m && m.yearSeconds < 86_400 && (
        <p className="clock-chip">
          <span className="tick" /> Demo clock · one year of interest accrues every {fmt(m.yearSeconds / 60, 0)} minutes
        </p>
      )}
    </div>
  )
}

export function UtilRing({ util }: { util: number }) {
  const r = 52
  const c = 2 * Math.PI * r
  return (
    <div className="util-ring" aria-label={`Utilization ${fmt(util * 100, 1)}%`}>
      <svg viewBox="0 0 128 128" width="128" height="128">
        <defs>
          <linearGradient id="util-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--brass-hi)" />
            <stop offset="1" stopColor="var(--verdigris)" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--line)" strokeWidth="9" />
        <motion.circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="url(#util-g)"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - util) }}
          transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
          transform="rotate(-90 64 64)"
        />
      </svg>
      <div className="util-label">
        <Rolling value={util * 100} digits={1} className="mono" />
        <span>% used</span>
      </div>
    </div>
  )
}

// Semicircle gauge: 0 (liquidation) .. 3+ (very safe)
export function HealthGauge({ hf, size = 150 }: { hf: number; size?: number }) {
  const clamped = Math.max(0, Math.min(3, Number.isFinite(hf) ? hf : 3))
  const angle = -90 + (clamped / 3) * 180
  const tone = hf < 1.1 ? 'danger' : hf < 1.5 ? 'warn' : 'safe'
  return (
    <div className={`gauge ${tone}`} style={{ width: size }}>
      <svg viewBox="0 0 160 92" width={size}>
        <defs>
          <linearGradient id="gauge-g" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--rose)" />
            <stop offset="0.38" stopColor="var(--amber)" />
            <stop offset="0.7" stopColor="var(--verdigris)" />
          </linearGradient>
        </defs>
        <path d="M14 84 A66 66 0 0 1 146 84" fill="none" stroke="url(#gauge-g)" strokeWidth="8" strokeLinecap="round" opacity="0.9" />
        {/* tick at health = 1, where liquidation becomes possible */}
        <line x1="49" y1="26" x2="53" y2="33" stroke="var(--ink-0)" strokeWidth="3" />
        <motion.line
          x1="80"
          y1="84"
          x2="80"
          y2="34"
          stroke="var(--text)"
          strokeWidth="2.5"
          strokeLinecap="round"
          style={{ transformBox: 'view-box', transformOrigin: '80px 84px' }}
          initial={{ rotate: -90 }}
          animate={{ rotate: angle }}
          transition={{ type: 'spring', stiffness: 60, damping: 12 }}
        />
        <circle cx="80" cy="84" r="5" fill="var(--text)" />
      </svg>
      <div className="gauge-val mono">{Number.isFinite(hf) ? fmt(hf, 2) : '∞'}</div>
      <div className="gauge-cap">health</div>
    </div>
  )
}

// ---------- borrow ----------

function BorrowCard({ ctx }: { ctx: Ctx }) {
  const { balances, holdingsFor, submit, party } = useOrvane()
  const [collRaw, setCollRaw] = useState('50000')
  const [ratio, setRatio] = useState(0.5) // share of max borrow
  const [state, setState] = useState<{ busy?: boolean; error?: string; ok?: string }>({})
  const m = ctx.m
  const coll = Number(collRaw) || 0
  const value = coll * ctx.price
  const max = m ? value * m.maxLtv : 0
  const amount = Math.floor(max * ratio * 100) / 100
  const hf = m ? healthFactor(value, m.liqLtv, amount) : Infinity
  const liqPx = m ? liquidationPrice(coll, m.liqLtv, amount) : 0
  const apr = m ? borrowAprBps(m, amount) : 0
  const short = coll > balances.CCx
  const noCash = m ? amount > m.cash : true

  const go = async () => {
    setState({ busy: true })
    try {
      await submit([
        borrow({ borrower: party!, operator: ctx.config.operator, marketId: ctx.market!.payload.marketId, holdings: holdingsFor('CCx'), collateralAmount: coll, borrowAmount: amount }),
      ])
      setState({ ok: 'Borrow request signed. The operator is settling it…' })
    } catch (e) {
      setState({ error: errorText(e) })
    }
  }

  return (
    <Panel delay={0.1}>
      <Tilt className="swap-card">
        <header className="card-head">
          <h2>Borrow</h2>
          <span className="muted small">APR {pct(apr)}</span>
        </header>
        <div className="leg">
          <div className="leg-top">
            <span>Lock collateral</span>
            <button className="link" onClick={() => setCollRaw(String(Math.floor(balances.CCx)))}>
              Balance {fmt(balances.CCx, 0)} · Max
            </button>
          </div>
          <div className="leg-main">
            <input className="amount mono" inputMode="decimal" value={collRaw} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setCollRaw(e.target.value)} aria-label="CCx collateral" />
            <span className="token-chip">
              <TokenGlyph symbol="CCx" /> CCx
            </span>
          </div>
          <div className="muted small">≈ ${fmt(value)} at {fmt(ctx.price, 4)}</div>
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
            <dd className="mono">{fmt(liqPx, 5)} USDx / CCx</dd>
          </div>
          <div>
            <dt>Visible to</dt>
            <dd className="visible-to">
              <span className="who you">You</span>
              <span className="who">Operator</span>
              <span className="who hidden">
                <EyeIcon closed /> lenders, members
              </span>
            </dd>
          </div>
        </dl>
        <button className={`primary ${state.busy ? 'busy' : ''}`} disabled={!m || amount <= 0 || short || noCash || state.busy} onClick={go}>
          <span>{short ? 'Not enough CCx' : noCash ? 'Market lacks cash' : state.busy ? 'Signing…' : 'Lock collateral & borrow'}</span>
        </button>
        {state.ok && <p className="tx-ok">{state.ok}</p>}
        {state.error && <p className="tx-error">{state.error}</p>}
      </Tilt>
    </Panel>
  )
}

// ---------- loans ----------

function Loans({ ctx }: { ctx: Ctx }) {
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
          {ctx.loans.map((l) => (
            <LoanCard key={l.contractId} loan={l} ctx={ctx} />
          ))}
        </AnimatePresence>
      </ul>
      {ctx.closed.length > 0 && (
        <>
          <h4 className="sub">Closed</h4>
          <ul className="mini-list">
            {ctx.closed.slice(0, 4).map((c) => (
              <li key={c.contractId}>
                <span className="mono">{fmt(+c.payload.principal)} USDx</span>
                <span className="mono small">+{fmt(+c.payload.interest, 4)} interest</span>
                <span className={`tag ${c.payload.liquidated ? 'warn-tag' : 'tag-SwapReceipt'}`}>{c.payload.liquidated ? 'liquidated' : 'repaid'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

function LoanCard({ loan, ctx }: { loan: Contract<Loan>; ctx: Ctx }) {
  const { balances, holdingsFor, submit } = useOrvane()
  const now = useNow(1000)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const l = loan.payload
  const m = ctx.m
  const owed = m ? owedAt(m.yearSeconds, +l.principal, +l.aprBps, l.openedAt, now) : +l.principal
  const value = +l.collateralAmount * ctx.price
  const hf = m ? healthFactor(value, m.liqLtv, owed) : Infinity
  const liqPx = m ? liquidationPrice(+l.collateralAmount, m.liqLtv, owed) : 0
  const topUp = Math.min(balances.CCx, Math.round(+l.collateralAmount * 0.25))

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(what)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(undefined)
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
            {fmt(+l.collateralAmount, 0)} CCx ≈ ${fmt(value)}
          </dd>
        </div>
        <div>
          <dt>Liquidates below</dt>
          <dd className={`mono ${hf < 1.5 ? 'warn' : ''}`}>{fmt(liqPx, 5)}</dd>
        </div>
      </dl>
      <div className="inv-actions">
        <button
          className="chip-btn"
          disabled={!!busy || balances.USDx < owed * 1.001 || !ctx.market}
          onClick={() => act('repay', () => submit([repayLoan(loan.contractId, holdingsFor('USDx'), ctx.market!.contractId)]))}
        >
          {busy === 'repay' ? 'Repaying…' : `Repay ${fmt(owed, 2)}`}
        </button>
        <button
          className="chip-btn cc"
          disabled={!!busy || topUp <= 0}
          onClick={() => act('add', () => submit([addCollateral(loan.contractId, holdingsFor('CCx'), topUp)]))}
        >
          {busy === 'add' ? 'Locking…' : `+${fmtCompact(topUp)} CCx`}
        </button>
      </div>
      {error && <p className="tx-error">{error}</p>}
    </motion.li>
  )
}

// ---------- supply ----------

function SupplyCard({ ctx }: { ctx: Ctx }) {
  const { balances, holdingsFor, submit, party } = useOrvane()
  const [raw, setRaw] = useState('5000')
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})
  const m = ctx.m
  const amount = Number(raw) || 0
  const sv = m ? shareValue(m) : 1
  const myShares = ctx.positions.reduce((s, p) => s + Number(p.payload.shares), 0)

  const run = async (cmd: Parameters<typeof submit>[0]) => {
    setState({ busy: true })
    try {
      await submit(cmd)
      setState({})
    } catch (e) {
      setState({ error: errorText(e) })
    }
  }

  return (
    <Panel delay={0.2}>
      <header className="card-head">
        <h3>Supply</h3>
        <span className="muted small ok">earn {m ? pct(supplyAprBps(m)) : '–'}</span>
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
        <button className="chip-btn" disabled={state.busy || amount <= 0 || amount > balances.USDx} onClick={() => run([supply(party!, ctx.config.operator, ctx.market!.payload.marketId, holdingsFor('USDx'), amount)])}>
          Supply
        </button>
        {ctx.positions[0] && (
          <button className="chip-btn ghosty" disabled={state.busy} onClick={() => run(ctx.positions.map((p) => withdrawSupply(party!, ctx.config.operator, p.contractId)))}>
            Withdraw all
          </button>
        )}
      </div>
      {state.error && <p className="tx-error">{state.error}</p>}
    </Panel>
  )
}

// ---------- advances ----------

function AdvanceCard({ ctx, line }: { ctx: Ctx; line: Contract<AdvanceLine> }) {
  const { submit, party } = useOrvane()
  const l = line.payload
  const open = ctx.advances.find((a) => a.payload.employee === party)
  const [raw, setRaw] = useState(String(Math.floor(+l.limit * 0.6)))
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})
  const amount = Math.min(Number(raw) || 0, +l.limit)
  const fee = (amount * +l.feeBps) / 10_000

  const go = async () => {
    setState({ busy: true })
    try {
      await submit([requestAdvance(party!, ctx.config.operator, line.contractId, amount)])
      setState({})
    } catch (e) {
      setState({ error: errorText(e) })
    }
  }

  return (
    <Panel delay={0.12} className="advance-card">
      <header className="card-head">
        <h2>Get paid early</h2>
        <span className="muted small">backed by Acme</span>
      </header>
      {open ? (
        <div className="advance-open">
          <div>
            <span className="muted small">Advance received</span>
            <span className="mono big-ish ok">{fmt(+open.payload.principal)} USDx</span>
          </div>
          <p className="muted small">
            {fmt(+open.payload.principal + +open.payload.fee)} USDx (incl. {fmt(+open.payload.fee)} fee) comes out of your next payslip automatically. Your
            colleagues and the lenders can't see this.
          </p>
        </div>
      ) : (
        <>
          <div className="advance-limit">
            <span className="muted small">Available</span>
            <span className="mono big-ish">{fmt(+l.limit - +l.drawn)}</span>
            <span className="muted small">USDx of {fmt(+l.limit)}</span>
          </div>
          <input
            type="range"
            className="slider"
            min={0}
            max={+l.limit}
            step={10}
            value={amount}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Advance amount"
            style={{ '--fill': `${(amount / +l.limit) * 100}%` } as React.CSSProperties}
          />
          <dl className="details tight">
            <div>
              <dt>You get now</dt>
              <dd className="mono strong">{fmt(amount)} USDx</dd>
            </div>
            <div>
              <dt>Deducted next payroll</dt>
              <dd className="mono">
                {fmt(amount + fee)} USDx ({fmt(+l.feeBps / 100, 0)}% fee)
              </dd>
            </div>
          </dl>
          <button className={`primary ${state.busy ? 'busy' : ''}`} disabled={state.busy || amount <= 0 || ctx.pending > 0} onClick={go}>
            <span>{state.busy || ctx.pending > 0 ? 'Settling…' : `Get ${fmt(amount, 0)} USDx now`}</span>
          </button>
        </>
      )}
      {state.error && <p className="tx-error">{state.error}</p>}
    </Panel>
  )
}

function AdvanceLines({ ctx }: { ctx: Ctx }) {
  const { submit, config } = useOrvane()
  const [error, setError] = useState<string>()
  const name = (p: string) => config?.personas.find((x) => x.party === p)?.name ?? p.split('::')[0]
  return (
    <Panel delay={0.25}>
      <header className="card-head">
        <h3>Wage advances you back</h3>
        <span className="muted small">deducted at payroll</span>
      </header>
      <ul className="mini-list">
        {ctx.lines.map((line) => {
          const l = line.payload
          const adv = ctx.advances.find((a) => a.payload.employee === l.employee)
          const change = (delta: number) =>
            submit([setAdvanceLimit(line.contractId, Math.max(0, +l.limit + delta))]).catch((e) => setError(errorText(e)))
          return (
            <li key={line.contractId}>
              <span>{name(l.employee)}</span>
              <span className="mono small">
                {adv ? `owes ${fmt(+adv.payload.principal + +adv.payload.fee)}` : 'no advance'} · limit {fmt(+l.limit, 0)}
              </span>
              <span className="stepper">
                <button onClick={() => change(-250)} aria-label={`Lower ${name(l.employee)}'s limit`}>
                  −
                </button>
                <button onClick={() => change(250)} aria-label={`Raise ${name(l.employee)}'s limit`}>
                  +
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      {error && <p className="tx-error">{error}</p>}
    </Panel>
  )
}
