// Trade on LocalNet: USDx against real Canton Coin, settled through
// CIP-56 token-standard allocations.

import { signalSettled } from '../three/settle.ts'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { amountOut, priceImpact } from '../../../shared/amm.ts'
import { HOLDING_V1, Scan, type HoldingView, type InstrumentId } from '../../../shared/amulet.ts'
import { LedgerError } from '../../../shared/ledger.ts'
import { X, prepareSwapOrder, registries, sameInstrument, type ExchangePool, type ExchangeReceipt } from '../../../shared/exchange.ts'
import { VaultStage } from '../three/stage.tsx'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { pick, usePolled } from '../ledger/usePolled.ts'
import type { PricePoint } from '../ledger/OrvaneProvider.tsx'
import { EyeIcon, Panel, Rolling, Sparkline, Tilt, TokenGlyph, fmt, fmtCompact } from '../ui/bits.tsx'

const SLIPPAGES = [0.5, 1, 3]
const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)
const glyph = (i: InstrumentId) => (i.id === 'USDx' ? 'USDx' : 'CCx')

type Phase = { phase: 'idle' | 'signing' | 'settling' | 'done' | 'error'; ref?: string; message?: string; receipt?: ExchangeReceipt }

export default function ExchangeTrade() {
  const { config, ledger, party, persona } = useOrvane()
  const ex = config!.exchange!
  const rows = usePolled([X.ExchangePool, X.ExchangeReceipt], 1200)
  const pool = pick<ExchangePool>(rows, 'ExchangePool').find((p) => p.payload.poolId === ex.poolId)
  const receipts = pick<ExchangeReceipt>(rows, 'ExchangeReceipt')
    .filter((r) => r.payload.trader === party)
    .reverse()
  const [holdings, setHoldings] = useState<Array<{ view: HoldingView }>>([])
  const [history, setHistory] = useState<PricePoint[]>([])
  const [fromCC, setFromCC] = useState(true)
  const [raw, setRaw] = useState('')
  const [slippage, setSlippage] = useState(1)
  const [flips, setFlips] = useState(0)
  const [tx, setTx] = useState<Phase>({ phase: 'idle' })

  // balances straight from the Holding interface, across both registries
  useEffect(() => {
    if (!party) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const hs = await ledger.queryInterface<HoldingView>(party, HOLDING_V1)
        if (alive) setHoldings(hs.filter((h) => h.view.owner === party))
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
  }, [ledger, party])

  // price history from every version of the pool this party has seen
  useEffect(() => {
    if (!party) return
    let alive = true
    const load = async () => {
      try {
        const h = await ledger.history(party, [X.ExchangePool])
        if (alive)
          setHistory(
            h
              .map(({ at, event }) => {
                const p = event.createArgument as ExchangePool
                return { at: Date.parse(at), price: +p.reserveB ? +p.reserveA / +p.reserveB : 0, reserveA: +p.reserveA, reserveB: +p.reserveB }
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
  }, [ledger, party, pool?.contractId])

  // settlement watcher
  useEffect(() => {
    if (tx.phase !== 'settling' || !tx.ref) return
    const r = receipts.find((x) => x.payload.settlementRef === tx.ref)
    if (r) {
      setTx({ phase: 'done', receipt: r.payload })
      signalSettled(r.payload.instrumentIn.id === 'USDx' ? 'USDx' : 'CCx')
    }
  }, [receipts, tx])
  useEffect(() => {
    if (tx.phase !== 'settling') return
    const t = setTimeout(() => setTx((s) => (s.phase === 'settling' ? { phase: 'error', message: 'Not settled yet. If the price moved past your minimum, your funds were returned.' } : s)), 25_000)
    return () => clearTimeout(t)
  }, [tx.phase])

  const balance = (i: InstrumentId) => holdings.filter((h) => sameInstrument(h.view.instrumentId, i) && !h.view.lock).reduce((s, h) => s + +h.view.amount, 0)
  const from = fromCC ? ex.amulet : ex.usdx
  const to = fromCC ? ex.usdx : ex.amulet
  const p = pool?.payload
  const fromIsA = p ? sameInstrument(from, p.instrA) : false
  const [resIn, resOut] = p ? (fromIsA ? [+p.reserveA, +p.reserveB] : [+p.reserveB, +p.reserveA]) : [0, 0]
  const amount = Number(raw) || 0
  const out = p ? amountOut(+p.feeBps, amount, resIn, resOut) : 0
  const impact = p ? priceImpact(+p.feeBps, amount, resIn, resOut) : 0
  const minOut = out * (1 - slippage / 100)
  const price = p && +p.reserveB ? +p.reserveA / +p.reserveB : 0 // USDx per CC
  const change = useMemo(() => (history.length > 1 ? ((history[history.length - 1].price - history[0].price) / history[0].price) * 100 : 0), [history])

  // the orbs weigh each side of the pool against where it started
  const seed = history[0]
  const weights: [number, number] | undefined = p && seed ? [+p.reserveA / seed.reserveA, +p.reserveB / seed.reserveB] : undefined

  const busy = tx.phase === 'signing' || tx.phase === 'settling'
  const insufficient = amount > balance(from)
  const disabled = !pool || amount <= 0 || insufficient || busy

  const submit = async () => {
    if (disabled || !party) return
    setTx({ phase: 'signing' })
    try {
      const reg = registries(ledger, new Scan(''), ex.realAmulet ? ex.amulet.admin : '')
      const order = await prepareSwapOrder({ ledger, reg, trader: party, operator: config!.operator, poolId: ex.poolId, input: from, amount, minOut })
      await ledger.submit([party], [order.command], [], order.disclosed)
      setTx({ phase: 'settling', ref: order.ref })
    } catch (e) {
      setTx({ phase: 'error', message: e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e) })
    }
  }

  const reached = tx.phase === 'signing' ? 0 : tx.phase === 'settling' ? 2 : tx.phase === 'done' ? 4 : -1

  return (
    <div className="page page-trade">
      <div className="narrative">
        <VaultStage scene="trade" weights={weights} />
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          USDx / CC · {ex.realAmulet ? 'Canton LocalNet · real Canton Coin' : 'Canton sandbox · CIP-56 test CC'}
        </motion.p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            {ex.realAmulet ? 'Real Canton Coin.' : 'Token-standard CC.'}
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>No audience.</em>
          </motion.span>
        </h1>
        <motion.div className="price-block" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <div className="price-row">
            <span className="price-label">1 CC</span>
            <Rolling value={price} digits={6} className="price-value mono" />
            <span className="price-unit">USDx</span>
            <span className={`delta ${change >= 0 ? 'up' : 'down'}`}>
              {change >= 0 ? '▲' : '▼'} {fmt(Math.abs(change), 2)}%
            </span>
          </div>
          <Sparkline points={history} />
          <dl className="stats">
            <div>
              <dt>Liquidity</dt>
              <dd className="mono">${fmtCompact((p ? +p.reserveA : 0) * 2)}</dd>
            </div>
            <div>
              <dt>Reserves</dt>
              <dd className="mono">
                {fmtCompact(p ? +p.reserveA : 0)} USDx / {fmtCompact(p ? +p.reserveB : 0)} CC
              </dd>
            </div>
            <div>
              <dt>Settlement</dt>
              <dd className="mono">DvP allocations</dd>
            </div>
          </dl>
          <p className="whisper">
            <EyeIcon /> Your CC is locked by the token standard, then swapped atomically. Nobody else sees the trade.
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
                <button className="link" onClick={() => setRaw(String(Math.floor(balance(from) * 100) / 100))}>
                  Balance {fmt(balance(from))} · Max
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
                    if (tx.phase === 'done' || tx.phase === 'error') setTx({ phase: 'idle' })
                  }}
                  aria-label={`Amount of ${label(from)} to pay`}
                />
                <span className="token-chip">
                  <TokenGlyph symbol={glyph(from)} /> {label(from)}
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
                  setFromCC(!fromCC)
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
                <span className="muted">Balance {fmt(balance(to))}</span>
              </div>
              <div className="leg-main">
                <Rolling value={out} digits={4} className="amount mono out" />
                <span className="token-chip">
                  <TokenGlyph symbol={glyph(to)} /> {label(to)}
                </span>
              </div>
            </div>
            <dl className="details">
              <div>
                <dt>Price impact</dt>
                <dd className={`mono ${impact > 3 ? 'warn' : impact > 1 ? 'soft-warn' : ''}`}>{fmt(impact, 2)}%</dd>
              </div>
              <div>
                <dt>Minimum received</dt>
                <dd className="mono">
                  {fmt(minOut, 4)} {label(to)}
                </dd>
              </div>
              <div>
                <dt>Visible to</dt>
                <dd className="visible-to">
                  <span className="who you">{persona?.name}</span>
                  <span className="who">Operator</span>
                  <span className="who hidden">
                    <EyeIcon closed /> everyone else
                  </span>
                </dd>
              </div>
            </dl>
            <button className={`primary ${busy ? 'busy' : ''}`} disabled={disabled} onClick={submit}>
              <span>
                {!pool
                  ? 'Waiting for pool'
                  : amount <= 0
                    ? 'Enter an amount'
                    : insufficient
                      ? `Not enough ${label(from)}`
                      : tx.phase === 'signing'
                        ? 'Locking funds…'
                        : tx.phase === 'settling'
                          ? 'Settling atomically…'
                          : 'Lock & swap privately'}
              </span>
            </button>
            {tx.phase !== 'idle' && (
              <motion.div className="timeline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                {tx.phase === 'error' ? (
                  <p className="tx-error">{tx.message}</p>
                ) : (
                  <ol>
                    {['Signed by you', `${label(from)} allocated`, 'Both legs settled', 'Receipt delivered'].map((s, i) => (
                      <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
                        <span className="dot" />
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
                {tx.phase === 'done' && tx.receipt && (
                  <p className="tx-ok mono">
                    +{fmt(+tx.receipt.amountOut, 4)} {label(tx.receipt.instrumentOut)}
                  </p>
                )}
              </motion.div>
            )}
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
                  <motion.li key={r.contractId} layout initial={{ opacity: 0, x: 24, filter: 'blur(6px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}>
                    <span className="mono">
                      {fmt(+r.payload.amountIn)} {label(r.payload.instrumentIn)}
                    </span>
                    <span className="arrow">→</span>
                    <span className="mono strong">
                      {fmt(+r.payload.amountOut, 4)} {label(r.payload.instrumentOut)}
                    </span>
                    <span className="cid mono" title={r.payload.settlementRef}>
                      {r.payload.settlementRef.slice(-5)}
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
