// The Orvane pool's own swap (LocalNet, kept for later): sell an exact
// amount for at least a minimum, in one transaction.
//
// The quote uses the same arithmetic as the contract, so the number shown is
// the number filled unless someone trades first; then the minimum protects
// the trader and the swap is handed back instead of filling worse.

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { ZERO, dec, toNumber, type Dec } from '../../../shared/decimal.ts'
import { minOutFor, quote, type SwapReceipt } from '../../../shared/dex.ts'
import { useDex } from '../ledger/dex.tsx'
import { Rejected, cancelSwap, swap } from '../ledger/orders.ts'
import { VaultStage } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, EyeIcon, Panel, Rolling, SkeletonList, Sparkline, Tilt, TokenGlyph, fmt, fmtCompact, glyphFor } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'

const SLIPPAGES = [50, 100, 300] // bps
const AMOUNT = /^\d*\.?\d{0,10}$/

type Phase = { phase: 'idle' | 'signing' | 'settling' | 'done' | 'error'; message?: string; receipt?: SwapReceipt }

export default function PoolSwap() {
  const dex = useDex()
  const { config, pools, party, mine, loaded, instrument, free } = dex
  const activity = useActivity()
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined
  const [sellA, setSellA] = useState(true)
  const [raw, setRaw] = useState('')
  const [slippage, setSlippage] = useState(100)
  const [flips, setFlips] = useState(0)
  const [tx, setTx] = useState<Phase>({ phase: 'idle' })
  const [busyCancel, setBusyCancel] = useState<string>()

  const from = pool ? (sellA ? pool.instrumentA : pool.instrumentB) : undefined
  const to = pool ? (sellA ? pool.instrumentB : pool.instrumentA) : undefined
  const fromI = from ? instrument(from) : undefined
  const toI = to ? instrument(to) : undefined

  let amountIn: Dec = ZERO
  try {
    amountIn = raw ? dec(raw) : ZERO
  } catch {
    amountIn = ZERO
  }
  const empty = !live || live.positions === 0
  const [reserveIn, reserveOut] = live ? (sellA ? [live.reserveA, live.reserveB] : [live.reserveB, live.reserveA]) : [ZERO, ZERO]
  const q = useMemo(() => (pool && !empty && amountIn > ZERO ? quote({ feeBps: pool.feeBps, reserveIn, reserveOut }, amountIn) : undefined), [pool, empty, amountIn, reserveIn, reserveOut])
  const minOut = q ? minOutFor(q.amountOut, slippage) : ZERO
  const priceAinB = live && live.reserveA > ZERO ? toNumber(live.reserveB) / toNumber(live.reserveA) : 0
  const history = live?.recent ?? []
  const change = history.length > 1 ? ((history[history.length - 1].price - history[0].price) / history[0].price) * 100 : 0

  const balanceIn = from ? free(from) : ZERO
  const busy = tx.phase === 'signing' || tx.phase === 'settling'
  const paused = live?.status === 'Paused'
  const insufficient = amountIn > balanceIn
  const disabled = !party || !pool || empty || paused || amountIn <= ZERO || insufficient || busy || !q || q.amountOut <= ZERO || minOut <= ZERO

  useEffect(() => {
    if (tx.phase === 'done' || tx.phase === 'error') {
      const t = setTimeout(() => setTx({ phase: 'idle' }), 12_000)
      return () => clearTimeout(t)
    }
  }, [tx.phase])

  const submit = async () => {
    if (disabled || !pool || !from || !to || !q) return
    setTx({ phase: 'signing' })
    const id = activity.start(`Swap ${fmt(toNumber(amountIn), 4)} ${fromI!.label} for ${toI!.label}`, 'Waiting for your signature…')
    try {
      const receipt = await swap(dex, { pool, instrumentIn: from, instrumentOut: to, amountIn, minOut }, () => {
        setTx({ phase: 'settling' })
        activity.update(id, { detail: 'Signed. Settling against every position in one transaction…' })
      })
      setTx({ phase: 'done', receipt })
      setRaw('')
      activity.done(id, { detail: `+${fmt(+receipt.amountOut, 4)} ${toI!.label}. Only you and the operator can read the receipt.` })
      signalSettled(sellA ? 'CCx' : 'USDx')
    } catch (e) {
      const message = e instanceof Rejected ? `Handed back: ${e.message}. Your funds are unlocked.` : errorText(e)
      setTx({ phase: 'error', message })
      activity.fail(id, e instanceof Rejected ? `${e.message}` : e)
    }
  }

  const reached = tx.phase === 'signing' ? 0 : tx.phase === 'settling' ? 2 : tx.phase === 'done' ? 4 : -1

  return (
    <div className="page page-trade">
      <div className="narrative">
        <VaultStage scene="trade" />
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          {pool ? `${instrument(pool.instrumentA).label} / ${instrument(pool.instrumentB).label}` : 'Swap'} · token standard V2 · {config?.network === 'localnet' ? 'Canton LocalNet' : config?.network}
        </motion.p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Trade in the open.
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>Be seen by no one.</em>
          </motion.span>
        </h1>
        <motion.div className="price-block" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <div className="price-row">
            <span className="price-label">1 {pool ? instrument(pool.instrumentA).label : ''}</span>
            <Rolling value={priceAinB} digits={6} className="price-value mono" />
            <span className="price-unit">{pool ? instrument(pool.instrumentB).label : ''}</span>
            {history.length > 1 && (
              <span className={`delta ${change >= 0 ? 'up' : 'down'}`}>
                {change >= 0 ? '▲' : '▼'} {fmt(Math.abs(change), 2)}%
              </span>
            )}
          </div>
          <Sparkline points={history} />
          <dl className="stats">
            <div>
              <dt>Reserves</dt>
              <dd className="mono">
                {live ? `${fmtCompact(toNumber(live.reserveA))} ${instrument(pool!.instrumentA).label} · ${fmtCompact(toNumber(live.reserveB))} ${instrument(pool!.instrumentB).label}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Liquidity providers</dt>
              <dd className="mono">{live?.positions ?? '—'}</dd>
            </div>
            <div>
              <dt>Fee</dt>
              <dd className="mono">{pool ? `${fmt(pool.feeBps / 100)}% to LPs` : '—'}</dd>
            </div>
          </dl>
          <p className="whisper">
            <EyeIcon /> Your input settles against every provider at once, through the operator. Providers never learn who traded, and you never learn
            who provided.
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
                    {s / 100}%
                  </button>
                ))}
              </div>
            </header>
            <div className="leg">
              <div className="leg-top">
                <span>You pay</span>
                {party && fromI && (
                  <button className="link" onClick={() => setRaw(String(Math.floor(toNumber(balanceIn) * 10_000) / 10_000))}>
                    Balance {fmt(toNumber(balanceIn), 4)} · Max
                  </button>
                )}
              </div>
              <div className="leg-main">
                <input
                  className="amount mono"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={raw}
                  onChange={(e) => {
                    if (AMOUNT.test(e.target.value)) setRaw(e.target.value)
                    if (tx.phase === 'done' || tx.phase === 'error') setTx({ phase: 'idle' })
                  }}
                  aria-label={`Amount of ${fromI?.label ?? ''} to pay`}
                />
                {fromI && (
                  <span className="token-chip">
                    <TokenGlyph symbol={glyphFor(fromI.key)} /> {fromI.label}
                  </span>
                )}
              </div>
            </div>
            <div className="flip-wrap">
              <motion.button
                className="flip"
                aria-label="Switch direction"
                animate={{ rotate: flips * 180 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                onClick={() => {
                  setSellA(!sellA)
                  setRaw('')
                  setFlips((f) => f + 1)
                  setTx({ phase: 'idle' })
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
                {party && to && <span className="muted">Balance {fmt(toNumber(free(to)), 4)}</span>}
              </div>
              <div className="leg-main">
                <Rolling value={q ? toNumber(q.amountOut) : 0} digits={6} className="amount mono out" />
                {toI && (
                  <span className="token-chip">
                    <TokenGlyph symbol={glyphFor(toI.key)} /> {toI.label}
                  </span>
                )}
              </div>
            </div>
            <dl className="details">
              <div>
                <dt>Price impact</dt>
                <dd className={`mono ${q && q.priceImpactBps > 300 ? 'warn' : q && q.priceImpactBps > 100 ? 'soft-warn' : ''}`}>{q ? fmt(q.priceImpactBps / 100, 2) : '0.00'}%</dd>
              </div>
              <div>
                <dt>Minimum received</dt>
                <dd className="mono">
                  {fmt(toNumber(minOut), 6)} {toI?.label}
                </dd>
              </div>
              <div>
                <dt>Visible to</dt>
                <dd className="visible-to">
                  <span className="who you">You</span>
                  <span className="who">Operator</span>
                  <span className="who hidden">
                    <EyeIcon closed /> providers, everyone else
                  </span>
                </dd>
              </div>
            </dl>
            {!party ? (
              <ConnectFirst what="swap" />
            ) : (
              <button className={`primary ${busy ? 'busy' : ''}`} disabled={disabled} onClick={submit}>
                <span>
                  {!pool
                    ? 'Waiting for the operator'
                    : empty
                      ? 'The pool has no liquidity yet'
                      : paused
                        ? 'The pool is paused'
                        : amountIn <= ZERO
                          ? 'Enter an amount'
                          : insufficient
                            ? `Not enough ${fromI?.label}`
                            : tx.phase === 'signing'
                              ? 'Sign in your wallet…'
                              : tx.phase === 'settling'
                                ? 'Settling atomically…'
                                : 'Swap privately · one signature'}
                </span>
              </button>
            )}
            {tx.phase !== 'idle' && (
              <motion.div className="timeline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                {tx.phase === 'error' ? (
                  <p className="tx-error">{tx.message}</p>
                ) : (
                  <ol>
                    {['Signed in your wallet', `${fromI?.label} locked for this swap`, 'Settled with every provider', 'Receipt on your node'].map((s, i) => (
                      <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
                        <span className="dot" />
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
                {tx.phase === 'done' && tx.receipt && (
                  <p className="tx-ok mono">
                    +{fmt(+tx.receipt.amountOut, 6)} {instrument(tx.receipt.instrumentOut).label}
                  </p>
                )}
              </motion.div>
            )}
          </Tilt>
        </Panel>

        {party && (
          <Panel delay={0.3} className="receipts">
            <header className="card-head">
              <h3>Your trades</h3>
              <span className="muted small">receipts only you and the operator can read</span>
            </header>
            {mine.swaps.length > 0 && (
              <ul className="receipt-list pending-list">
                {mine.swaps.map((r) => (
                  <li key={r.contractId}>
                    <span className="mono">
                      {fmt(+r.payload.amountIn, 4)} {instrument(r.payload.instrumentIn).label}
                    </span>
                    <span className="arrow">→</span>
                    <span className="muted small">settling…</span>
                    <button
                      className="ghost small"
                      disabled={busyCancel === r.contractId}
                      onClick={async () => {
                        setBusyCancel(r.contractId)
                        try {
                          await activity.track('Cancel swap', () => cancelSwap(dex, r), { done: () => ({ detail: 'Your funds are unlocked.' }) })
                        } catch {
                          /* reported in Activity */
                        }
                        setBusyCancel(undefined)
                      }}
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {mine.receipts.length === 0 ? (
              loaded ? <p className="empty">No trades yet.</p> : <SkeletonList rows={3} />
            ) : (
              <ul className="receipt-list">
                <AnimatePresence initial={false}>
                  {mine.receipts.slice(0, 6).map((r) => (
                    <motion.li key={r.contractId} layout initial={{ opacity: 0, x: 24, filter: 'blur(6px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}>
                      <span className="mono">
                        {fmt(+r.payload.amountIn, 4)} {instrument(r.payload.instrumentIn).label}
                      </span>
                      <span className="arrow">→</span>
                      <span className="mono strong">
                        {fmt(+r.payload.amountOut, 4)} {instrument(r.payload.instrumentOut).label}
                      </span>
                      <span className="cid mono" title={new Date(r.payload.settledAt).toLocaleString()}>
                        {new Date(r.payload.settledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </Panel>
        )}
      </div>
    </div>
  )
}

