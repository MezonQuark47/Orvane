// Swap: any token Cantex lists, from your own wallet.
//
// Cantex supplies the pools; everything here is Orvane's: the live quote and
// its own check of it against the pools, the guard that re-prices right
// before you sign, the transfer from your wallet, and the tracker that
// watches your balance until the output lands.

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ZERO, dec, show, toNumber, type Dec } from '../../../shared/decimal.ts'
import { sameInstrument, type Instrument, type PoolState, type Quote, type Token } from '../../../shared/cantex.ts'
import { checkQuote, deviationBps, minimumOut } from '../../../shared/quote.ts'
import { useDex } from '../ledger/dex.tsx'
import { NETWORK } from '../ledger/network.ts'
import type { LoopAccount } from '../ledger/wallet.ts'
import { useMarket } from '../swap/market.tsx'
import { SwapBlocked, executeSwap, type Stage } from '../swap/execute.ts'
import { loadSwaps, onSwapsChanged, type SwapRecord } from '../swap/history.ts'
import { VaultStage } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, EyeIcon, Panel, Rolling, Sparkline, Tilt, TokenIcon, fmt, fmtCompact } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'
import { dateTime } from '../ui/time.ts'

const SLIPPAGES = [50, 100, 300] // bps
const AMOUNT = /^\d*\.?\d{0,10}$/
const REQUOTE_MS = 5_000
const STALE_MS = 15_000

type Phase = { phase: 'idle' } | { phase: 'busy'; stage: Stage } | { phase: 'done'; received: Dec; quoted: Dec; pending: boolean } | { phase: 'error'; message: string }

const parse = (s: string): Dec => {
  try {
    return s ? dec(s) : ZERO
  } catch {
    return ZERO
  }
}

export default function Swap() {
  const dex = useDex()
  const market = useMarket()
  const activity = useActivity()
  const { party, free, mine, wallet } = dex
  const { tokens, cc, api, policy, prices } = market
  const [sellId, setSellId] = useState<Instrument>()
  const [buyId, setBuyId] = useState<Instrument>()
  const [raw, setRaw] = useState('')
  const [slippage, setSlippage] = useState(100)
  const [flips, setFlips] = useState(0)
  const [quote, setQuote] = useState<Quote>()
  // the pools as they were when the quote came back, for Orvane's own check
  const [quotePools, setQuotePools] = useState<PoolState[]>()
  const [quoteError, setQuoteError] = useState<string>()
  const [now, setNow] = useState(() => Date.now())
  const [tx, setTx] = useState<Phase>({ phase: 'idle' })
  const [account, setAccount] = useState<LoopAccount>()

  // default pair: Canton Coin into a dollar token, if there is one
  useEffect(() => {
    if (!tokens.length || sellId) return
    const base = cc ?? tokens[0]
    const others = tokens.filter((t) => !sameInstrument(t, base))
    setSellId(base)
    setBuyId(others.find((t) => /usd/i.test(t.symbol)) ?? others[0])
  }, [tokens, cc, sellId])

  const sell = sellId ? market.token(sellId) : undefined
  const buy = buyId ? market.token(buyId) : undefined
  const amount = parse(raw)

  // quote as the user types, then keep it fresh
  const quoteSeq = useRef(0)
  useEffect(() => {
    setQuote(undefined)
    setQuoteError(undefined)
    if (!api || !sell || !buy || amount <= ZERO) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const run = async () => {
      const seq = ++quoteSeq.current
      try {
        const [q, ps] = await Promise.all([api.quote(sell, buy, show(amount)), api.pools()])
        if (alive && seq === quoteSeq.current) {
          setQuote(q)
          setQuotePools(ps)
          setQuoteError(undefined)
        }
      } catch (e) {
        if (alive && seq === quoteSeq.current) setQuoteError(e instanceof Error ? e.message.replace(/^Cantex: /, '') : String(e))
      }
      if (alive) timer = setTimeout(run, REQUOTE_MS)
    }
    timer = setTimeout(run, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, sell, buy, amount])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [])

  // Loop tells us whether the wallet can receive the output in one step
  useEffect(() => {
    setAccount(undefined)
    if (wallet.phase !== 'connected' || !wallet.session.account) return
    wallet.session.account().then(setAccount, () => setAccount(undefined))
  }, [wallet])

  const pool = sell && buy ? market.poolFor(sell, buy) : undefined
  const check = useMemo(() => (quote && cc ? safeCheck(quote, quotePools ?? market.pools, cc) : undefined), [quote, quotePools, market.pools, cc])
  const age = quote ? now - quote.receivedAt : 0
  const stale = !!quote && age > STALE_MS
  const minOut = quote ? minimumOut(dec(quote.returned.amount), slippage) : ZERO
  const balanceIn = sell ? free(sell) : ZERO
  const insufficient = amount > balanceIn
  const ccMin = policy ? dec(policy.minConnectSwapCc) : ZERO
  const belowMin = !!sell && !!cc && sameInstrument(sell, cc) && amount > ZERO && amount < ccMin
  const canReceive = !account || !buy || !cc ? true : sameInstrument(buy, cc) ? account.hasPreapproval : account.preapprovalAdmins.includes(buy.admin) || account.hasPreapproval
  const busy = tx.phase === 'busy'
  const reference = NETWORK.cantex ? prices[NETWORK.cantex.referenceMarket] : undefined
  // Canton Coin's price in a dollar pool, next to its market price
  const dollarPool = pool && cc && [pool.a, pool.b].some((s) => sameInstrument(s, cc)) && [pool.a.symbol, pool.b.symbol].some((x) => /usd/i.test(x))
  const poolPrice = pool && cc && dollarPool ? poolPriceInCc(pool, cc) : undefined
  const offMarket = poolPrice && reference ? deviationBps(poolPrice, reference.price) : 0
  const disabled = !party || !quote || stale || busy || insufficient || belowMin || !check?.agrees || !canReceive || amount <= ZERO

  const submit = async () => {
    if (disabled || !quote || !api || !cc || !sell || !buy) return
    const title = `Swap ${fmt(toNumber(amount), 4)} ${sell.symbol} for ${buy.symbol}`
    const id = activity.start(title, 'Checking the price…')
    setTx({ phase: 'busy', stage: 'checking' })
    try {
      const r = await executeSwap(dex, api, quote, {
        slippageBps: slippage,
        cc,
        onStage: (stage) => {
          setTx({ phase: 'busy', stage })
          activity.update(id, { detail: stage === 'signing' ? 'Sign in your wallet…' : stage === 'settling' ? 'Sent. Cantex is filling it from its pools…' : 'Checking the price…' })
        },
      })
      setTx({ phase: 'done', received: r.received, quoted: r.quoted, pending: r.status === 'pending' })
      if (r.status === 'filled') {
        activity.done(id, { detail: `+${fmt(toNumber(r.received), 6)} ${buy.symbol} in your wallet` })
        signalSettled(sell.symbol === 'CC' ? 'CCx' : 'USDx')
        setRaw('')
      } else {
        activity.done(id, { detail: 'Sent, not filled yet. If Cantex cannot fill it, cancel the pending transfer in your wallet.' })
      }
    } catch (e) {
      const message = e instanceof SwapBlocked ? e.message : errorText(e)
      setTx({ phase: 'error', message })
      activity.fail(id, e instanceof SwapBlocked ? e.message : e)
    }
  }

  const reached = tx.phase === 'busy' ? { checking: 0, signing: 1, settling: 2 }[tx.stage] : tx.phase === 'done' ? (tx.pending ? 2 : 4) : -1
  const symbol = pool?.symbol

  return (
    <div className="page page-trade">
      <div className="narrative">
        <VaultStage scene="trade" />
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          Swap · {NETWORK.label} · Cantex liquidity
        </motion.p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Swap from your wallet.
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>Checked twice.</em>
          </motion.span>
        </h1>
        {symbol && <PriceBlock symbol={symbol} poolPrice={poolPrice} reference={reference?.price} offMarket={offMarket} />}
        <p className="whisper">
          <EyeIcon /> Orvane holds nothing and charges nothing. Your wallet sends the swap straight to Cantex's pools; Orvane prices it itself first and
          re-checks it right before you sign.
        </p>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <Tilt className="swap-card">
            <header className="card-head">
              <h2>Swap</h2>
              <div className="slippage" role="radiogroup" aria-label="Price limit">
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
                {party && sell && (
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
                  aria-label="Amount to pay"
                />
                <TokenSelect tokens={tokens} value={sell} other={buy} onChange={(t) => (buy && sameInstrument(t, buy) ? (setBuyId(sellId), setSellId(t)) : setSellId(t))} />
              </div>
            </div>
            <div className="flip-wrap">
              <motion.button
                className="flip"
                aria-label="Switch direction"
                animate={{ rotate: flips * 180 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                onClick={() => {
                  setSellId(buyId)
                  setBuyId(sellId)
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
                {quote && <Freshness age={age} />}
              </div>
              <div className="leg-main">
                <Rolling value={quote ? toNumber(dec(quote.returned.amount)) : 0} digits={6} className="amount mono out" />
                <TokenSelect tokens={tokens} value={buy} other={sell} onChange={(t) => (sell && sameInstrument(t, sell) ? (setSellId(buyId), setBuyId(t)) : setBuyId(t))} />
              </div>
            </div>

            {quoteError && <p className="tx-error">{quoteError}</p>}
            {quote && sell && buy && (
              <dl className="details">
                <div>
                  <dt>Route</dt>
                  <dd className="mono route">{routeOf(quote, market.token)}</dd>
                </div>
                <div>
                  <dt>Price impact</dt>
                  <dd className={`mono ${check && check.priceImpactBps > 300 ? 'warn' : check && check.priceImpactBps > 100 ? 'soft-warn' : ''}`}>
                    {check ? fmt(check.priceImpactBps / 100, 2) : '—'}%
                  </dd>
                </div>
                <div>
                  <dt>Fees</dt>
                  <dd className="mono">
                    {fmt(toNumber(dec(quote.feePercentage)) * 100, 2)}% · {quote.networkFee.amount} CC network
                  </dd>
                </div>
                <div>
                  <dt>At least</dt>
                  <dd className="mono">
                    {fmt(toNumber(minOut), 6)} {buy.symbol}
                  </dd>
                </div>
                <div>
                  <dt>Orvane check</dt>
                  <dd className={check?.agrees ? 'ok' : 'warn'}>{check ? (check.agrees ? 'matches the pools' : `off by ${fmt(check.diffBps / 100, 2)}%`) : '—'}</dd>
                </div>
                <div>
                  <dt>Usually fills in</dt>
                  <dd className="mono">~{Math.round(quote.estimatedSeconds)} s</dd>
                </div>
              </dl>
            )}
            {offMarket > 1_000 && (
              <p className="tx-warn">
                This pool's price is {fmt(offMarket / 100, 0)}% away from the market price of Canton Coin. You would likely trade at a bad price.
              </p>
            )}
            {belowMin && <p className="tx-warn">Cantex fills swaps of at least {fmt(toNumber(ccMin), 0)} CC.</p>}
            {party && !canReceive && buy && (
              <p className="tx-warn">Your wallet can't receive {buy.symbol} in one step yet. Turn on receiving for {buy.symbol} (a transfer pre-approval) in your wallet first.</p>
            )}

            {!party ? (
              <ConnectFirst what="swap" />
            ) : (
              <button className={`primary ${busy ? 'busy' : ''}`} disabled={disabled} onClick={submit}>
                <span>
                  {busy
                    ? tx.stage === 'checking'
                      ? 'Checking the price…'
                      : tx.stage === 'signing'
                        ? 'Sign in your wallet…'
                        : 'Filling…'
                    : amount <= ZERO
                      ? 'Enter an amount'
                      : insufficient
                        ? `Not enough ${sell?.symbol}`
                        : belowMin
                          ? 'Below the minimum'
                          : !quote
                            ? quoteError
                              ? 'No quote'
                              : 'Getting a price…'
                            : stale
                              ? 'Updating the price…'
                              : check && !check.agrees
                                ? 'Quote does not match the pools'
                                : `Swap ${sell?.symbol} for ${buy?.symbol}`}
                </span>
              </button>
            )}

            {tx.phase !== 'idle' && (
              <motion.div className="timeline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                {tx.phase === 'error' ? (
                  <p className="tx-error">{tx.message}</p>
                ) : (
                  <ol>
                    {['Price checked twice', 'Signed in your wallet', 'Filled from Cantex pools', 'In your wallet'].map((s, i) => (
                      <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
                        <span className="dot" />
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
                {tx.phase === 'done' && !tx.pending && buy && (
                  <p className="tx-ok mono">
                    +{fmt(toNumber(tx.received), 6)} {buy.symbol}
                    <span className="muted small"> · quoted {fmt(toNumber(tx.quoted), 6)}</span>
                  </p>
                )}
                {tx.phase === 'done' && tx.pending && <p className="tx-warn">Sent, but not filled yet. If Cantex can't fill it, cancel the pending transfer in your wallet; your funds come back.</p>}
              </motion.div>
            )}
          </Tilt>
        </Panel>

        {party && <History party={party} pendingOut={mine.outgoing.filter((o) => o.receiver === NETWORK.cantex?.swapParty).length} />}
      </div>
    </div>
  )
}

function safeCheck(q: Quote, pools: Parameters<typeof checkQuote>[1], cc: Instrument) {
  try {
    return checkQuote(q, pools, cc, 25)
  } catch {
    return undefined
  }
}

// Canton Coin's price in the pool's other asset, the way the reference
// market quotes it.
function poolPriceInCc(pool: { a: Instrument; reserveA: string; reserveB: string }, cc: Instrument): number {
  const a = Number(pool.reserveA)
  const b = Number(pool.reserveB)
  return sameInstrument(pool.a, cc) ? b / a : a / b
}

function routeOf(q: Quote, token: (i: Instrument) => Token | undefined) {
  const sym = (i: Instrument) => token(i)?.symbol ?? i.id
  return [sym(q.sell), ...q.hops.map((h) => sym(h.buy))].join(' → ')
}

function Freshness({ age }: { age: number }) {
  const left = Math.max(0, 1 - age / STALE_MS)
  return (
    <span className="fresh muted small" title="Prices refresh every 5 seconds">
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--line-2)" strokeWidth="2" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--brass)" strokeWidth="2" strokeDasharray={`${left * 50.3} 50.3`} transform="rotate(-90 10 10)" />
      </svg>
      {age < 2_000 ? 'live' : `${Math.round(age / 1000)}s`}
    </span>
  )
}

function TokenSelect({ tokens, value, other, onChange }: { tokens: Token[]; value?: Token; other?: Token; onChange: (t: Token) => void }) {
  return (
    <label className="token-chip token-select">
      {value && <TokenIcon symbol={value.symbol} />}
      <select
        value={value ? `${value.admin}|${value.id}` : ''}
        onChange={(e) => {
          const t = tokens.find((x) => `${x.admin}|${x.id}` === e.target.value)
          if (t) onChange(t)
        }}
        aria-label="Token"
      >
        {tokens.map((t) => (
          <option key={`${t.admin}|${t.id}`} value={`${t.admin}|${t.id}`}>
            {t.symbol}
            {other && sameInstrument(t, other) ? ' (swap sides)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}

function PriceBlock({ symbol, poolPrice, reference, offMarket }: { symbol: string; poolPrice?: number; reference?: number; offMarket: number }) {
  const market = useMarket()
  useEffect(() => market.watchCandles(symbol, 3600), [market, symbol])
  const bars = market.candles[`${symbol}:3600`] ?? []
  const live = market.prices[symbol]?.price
  const pool = market.pools.find((p) => p.symbol === symbol)
  const [base, quoteSym] = symbol.split('-')
  // Cantex prices a market as its symbol reads: quote units per base unit
  const price = live ?? (pool ? Number(pool.price) : (poolPrice ?? 0))
  const first = bars[0]?.close
  const change = first ? ((price - first) / first) * 100 : 0
  return (
    <motion.div className="price-block" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
      <div className="price-row">
        <span className="price-label">1 {base}</span>
        <Rolling value={price} digits={price < 0.01 ? 8 : 6} className="price-value mono" />
        <span className="price-unit">{quoteSym}</span>
        {bars.length > 1 && (
          <span className={`delta ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '▲' : '▼'} {fmt(Math.abs(change), 2)}%
          </span>
        )}
      </div>
      <Sparkline points={bars.map((b) => ({ price: b.close }))} />
      <dl className="stats">
        <div>
          <dt>Pool depth</dt>
          <dd className="mono">{pool ? `${fmtCompact(Number(pool.tvlCc))} CC` : '—'}</dd>
        </div>
        <div>
          <dt>Pool fee</dt>
          <dd className="mono">{pool ? `${fmt(Number(pool.feeRate) * 100, 2)}%` : '—'}</dd>
        </div>
        <div>
          <dt>Market price</dt>
          <dd className={`mono ${offMarket > 1_000 ? 'warn' : ''}`}>{reference ? `CC ${fmt(reference, 5)} USDC` : '—'}</dd>
        </div>
      </dl>
    </motion.div>
  )
}

function History({ party, pendingOut }: { party: string; pendingOut: number }) {
  const market = useMarket()
  const [rows, setRows] = useState<SwapRecord[]>(() => loadSwaps(party))
  useEffect(() => {
    setRows(loadSwaps(party))
    return onSwapsChanged(() => setRows(loadSwaps(party)))
  }, [party])
  const sym = (i: Instrument) => market.token(i)?.symbol ?? i.id
  return (
    <Panel delay={0.3} className="receipts">
      <header className="card-head">
        <h3>Your swaps</h3>
        <span className="muted small">kept in this browser only</span>
      </header>
      {pendingOut > 0 && <p className="tx-warn small">{pendingOut} swap(s) sent and not filled yet. You can cancel a pending transfer in your wallet.</p>}
      {rows.length === 0 ? (
        <p className="empty">No swaps yet.</p>
      ) : (
        <ul className="receipt-list history">
          <AnimatePresence initial={false}>
            {rows.slice(0, 8).map((r) => (
              <motion.li key={r.id} layout initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} className={r.status === 'failed' ? 'warn' : undefined}>
                <span className="mono">
                  {fmt(Number(r.sell.amount), 4)} {sym(r.sell)} → {r.received ? fmt(Number(r.received), 6) : '…'} {sym(r.quoted)}
                </span>
                <span className="muted small">
                  {r.status === 'filled' ? `quoted ${fmt(Number(r.quoted.amount), 6)}` : r.status === 'pending' ? 'not filled yet' : r.status === 'failed' ? 'not sent' : 'sending'}
                </span>
                <span className="cid mono">{dateTime(new Date(r.at))}</span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  )
}
