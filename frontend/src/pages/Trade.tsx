import { VaultStage } from '../three/stage.tsx'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { amountOut, priceImpact } from '../../../shared/amm.ts'
import { useOrvane, type Symbol } from '../ledger/OrvaneProvider.tsx'
import { EyeIcon, Panel, Rolling, Sparkline, Tilt, TokenGlyph, fmt, fmtCompact } from '../ui/bits.tsx'

const SLIPPAGES = [0.1, 0.5, 1, 3]

export default function Trade() {
  const { pool, history, balances, swap, tx, resetTx, receipts, persona, config } = useOrvane()
  const [from, setFrom] = useState<Symbol>('USDx')
  const [raw, setRaw] = useState('')
  const [slippage, setSlippage] = useState(0.5)
  const [flips, setFlips] = useState(0)
  const to: Symbol = from === 'USDx' ? 'CCx' : 'USDx'

  const amount = Number(raw) || 0
  const [resIn, resOut] = pool ? (from === 'USDx' ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA]) : [0, 0]
  const out = pool ? amountOut(pool.feeBps, amount, resIn, resOut) : 0
  const impact = pool ? priceImpact(pool.feeBps, amount, resIn, resOut) : 0
  const minOut = out * (1 - slippage / 100)
  const rate = resIn ? resOut / resIn : 0

  const change = useMemo(() => {
    if (history.length < 2) return 0
    const first = history[0].price
    const last = history[history.length - 1].price
    return ((last - first) / first) * 100
  }, [history])

  const busy = tx.phase === 'signing' || tx.phase === 'settling'
  const insufficient = amount > balances[from]
  const disabled = !pool || amount <= 0 || insufficient || busy

  const submit = () => {
    if (disabled) return
    swap(from, amount, minOut)
  }

  const label = !pool
    ? 'Waiting for pool'
    : amount <= 0
      ? 'Enter an amount'
      : insufficient
        ? `Not enough ${from}`
        : tx.phase === 'signing'
          ? 'Signing…'
          : tx.phase === 'settling'
            ? 'Settling privately…'
            : 'Sign private swap'

  return (
    <div className="page page-trade">
      <div className="narrative">
        <VaultStage scene="trade" />
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          USDx / CCx · {config?.network === 'localnet' ? 'Canton LocalNet' : 'Canton sandbox'}
        </motion.p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Trade without
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>an audience.</em>
          </motion.span>
        </h1>
        <motion.div className="price-block" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
          <div className="price-row">
            <span className="price-label">1 CCx</span>
            <Rolling value={pool?.price ?? 0} digits={5} className="price-value mono" />
            <span className="price-unit">USDx</span>
            <span className={`delta ${change >= 0 ? 'up' : 'down'}`}>
              {change >= 0 ? '▲' : '▼'} {fmt(Math.abs(change), 2)}%
            </span>
          </div>
          <Sparkline points={history} />
          <dl className="stats">
            <div>
              <dt>Liquidity</dt>
              <dd className="mono">${fmtCompact((pool?.reserveA ?? 0) * 2)}</dd>
            </div>
            <div>
              <dt>Reserves</dt>
              <dd className="mono">
                {fmtCompact(pool?.reserveA ?? 0)} / {fmtCompact(pool?.reserveB ?? 0)}
              </dd>
            </div>
            <div>
              <dt>LP fee</dt>
              <dd className="mono">{fmt((pool?.feeBps ?? 0) / 100, 2)}%</dd>
            </div>
          </dl>
          <p className="whisper">
            <EyeIcon /> Pool members see the price. Nobody sees who moved it.
          </p>
        </motion.div>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <Tilt className="swap-card">
            <header className="card-head">
              <h2>Private swap</h2>
              <div className="slippage" role="radiogroup" aria-label="Slippage tolerance">
                {SLIPPAGES.map((s) => (
                  <button key={s} role="radio" aria-checked={slippage === s} className={slippage === s ? 'on' : ''} onClick={() => setSlippage(s)}>
                    {s}%
                  </button>
                ))}
              </div>
            </header>

            <div className="leg">
              <div className="leg-top">
                <span>You pay</span>
                <button className="link" onClick={() => setRaw(String(Math.floor(balances[from] * 100) / 100))}>
                  Balance {fmt(balances[from])} · Max
                </button>
              </div>
              <div className="leg-main">
                <input
                  className="amount mono"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={raw}
                  onChange={(e) => {
                    if (/^\d*\.?\d{0,6}$/.test(e.target.value)) setRaw(e.target.value)
                    if (tx.phase === 'done' || tx.phase === 'error') resetTx()
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  aria-label={`Amount of ${from} to pay`}
                />
                <span className="token-chip">
                  <TokenGlyph symbol={from} /> {from}
                </span>
              </div>
            </div>

            <div className="flip-wrap">
              <motion.button
                className="flip"
                aria-label="Switch direction"
                animate={{ rotate: flips * 180 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                onClick={() => {
                  setFrom(to)
                  setRaw('')
                  setFlips((f) => f + 1)
                  resetTx()
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                  <path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" />
                </svg>
              </motion.button>
            </div>

            <div className="leg leg-out">
              <div className="leg-top">
                <span>You receive</span>
                <span className="muted">Balance {fmt(balances[to])}</span>
              </div>
              <div className="leg-main">
                <Rolling value={out} digits={4} className="amount mono out" />
                <span className="token-chip">
                  <TokenGlyph symbol={to} /> {to}
                </span>
              </div>
            </div>

            <dl className="details">
              <div>
                <dt>Rate</dt>
                <dd className="mono">
                  1 {from} = {fmt(rate, from === 'USDx' ? 4 : 6)} {to}
                </dd>
              </div>
              <div>
                <dt>Price impact</dt>
                <dd className={`mono ${impact > 3 ? 'warn' : impact > 1 ? 'soft-warn' : ''}`}>{fmt(impact, 2)}%</dd>
              </div>
              <div>
                <dt>Minimum received</dt>
                <dd className="mono">
                  {fmt(minOut, 4)} {to}
                </dd>
              </div>
              <div>
                <dt>Visible to</dt>
                <dd className="visible-to">
                  <span className="who you">{persona?.name ?? 'You'}</span>
                  <span className="who">Operator</span>
                  <span className="who hidden">
                    <EyeIcon closed /> everyone else
                  </span>
                </dd>
              </div>
            </dl>

            <button className={`primary ${busy ? 'busy' : ''}`} disabled={disabled} onClick={submit}>
              <span>{label}</span>
            </button>

            <Timeline />
          </Tilt>
        </Panel>

        <Panel delay={0.3} className="receipts">
          <header className="card-head">
            <h3>Your receipts</h3>
            <span className="muted small">only you and the operator can read these</span>
          </header>
          {receipts.length === 0 ? (
            <p className="empty">No trades yet.</p>
          ) : (
            <ul className="receipt-list">
              <AnimatePresence initial={false}>
                {receipts.slice(0, 5).map((r) => (
                  <motion.li
                    key={r.contractId}
                    layout
                    initial={{ opacity: 0, x: 24, filter: 'blur(6px)' }}
                    animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                    exit={{ opacity: 0 }}
                  >
                    <span className="mono">
                      {fmt(+r.payload.amountIn)} {r.payload.symbolIn}
                    </span>
                    <span className="arrow">→</span>
                    <span className="mono strong">
                      {fmt(+r.payload.amountOut, 4)} {r.payload.symbolOut}
                    </span>
                    <span className="cid mono" title={r.contractId}>
                      #{r.contractId.slice(2, 8)}
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}

const STEPS = ['Signed by you', 'Disclosed to operator', 'Settled atomically', 'Receipt delivered']

function Timeline() {
  const { tx } = useOrvane()
  if (tx.kind !== 'swap' || tx.phase === 'idle') return null
  const reached = tx.phase === 'signing' ? 0 : tx.phase === 'settling' ? 2 : tx.phase === 'done' ? 4 : -1
  return (
    <motion.div className="timeline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
      {tx.phase === 'error' ? (
        <p className="tx-error">{tx.message}</p>
      ) : (
        <ol>
          {STEPS.map((s, i) => (
            <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
              <span className="dot" />
              {s}
            </li>
          ))}
        </ol>
      )}
      {tx.phase === 'done' && tx.receipt && (
        <p className="tx-ok mono">
          +{fmt(+tx.receipt.amountOut, 4)} {tx.receipt.symbolOut}
        </p>
      )}
    </motion.div>
  )
}
