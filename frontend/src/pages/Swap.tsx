// Swap: any token the venue lists (Cantex; OneSwap on DevNet), from your own wallet.
//
// The venue supplies the pools; everything here is Orvane's: the live quote and
// its own check of it against the pools, the guard that re-prices right
// before you sign, the transfer from your wallet, and the tracker that
// watches your balance until the output lands.

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ZERO, dec, show, toNumber, type Dec } from '../../../shared/decimal.ts'
import { sameInstrument, type Instrument, type PoolState, type Quote, type Token } from '../../../shared/cantex.ts'
import { CONFIRM_IMPACT_BPS, MAX_IMPACT_BPS, SWAP_TRANSFER_TTL_MS, checkQuote, deviationBps, minimumOut } from '../../../shared/quote.ts'
import { useDex } from '../ledger/dex.tsx'
import { NETWORK, VENUE } from '../ledger/network.ts'
import type { LoopAccount } from '../ledger/wallet.ts'
import type { FeeStatus } from '../ledger/fees.ts'
import { useMarket } from '../swap/market.tsx'
import { SwapBlocked, WATCH_MS, executeSwap, impactText, orvaneProxy, settleOpenSwaps, type Stage, type SwapResult } from '../swap/execute.ts'
import { loadSwaps, onSwapsChanged, type SwapRecord } from '../swap/history.ts'
import { TokenPicker } from '../swap/picker.tsx'
import { VaultStage } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, EyeIcon, Panel, Rolling, Sparkline, Tilt, fmt, fmtCompact } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'
import { clockTime, dateTime } from '../ui/time.ts'

const SLIPPAGES = [50, 100, 300] // bps
const AMOUNT = /^\d*\.?\d{0,10}$/
const REQUOTE_MS = 5_000
const STALE_MS = 15_000
const FEE_CHECK_MS = 8_000

type Phase =
  | { phase: 'idle' }
  | { phase: 'busy'; stage: Stage }
  | { phase: 'done'; received: Dec; quoted: Dec; outcome: SwapResult['status']; until: number }
  | { phase: 'error'; message: string }

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
  const { party, free, mine, wallet, loaded } = dex
  const { tokens, cc, api, policy, prices } = market
  const [sellId, setSellId] = useState<Instrument>()
  const [buyId, setBuyId] = useState<Instrument>()
  const [raw, setRaw] = useState('')
  const [slippage, setSlippage] = useState(100)
  const [flips, setFlips] = useState(0)
  const [showDetails, setShowDetails] = useState(false)
  const [quote, setQuote] = useState<Quote>()
  // the pools as they were when the quote came back, for Orvane's own check
  const [quotePools, setQuotePools] = useState<PoolState[]>()
  const [quoteError, setQuoteError] = useState<string>()
  const [now, setNow] = useState(() => Date.now())
  const [tx, setTx] = useState<Phase>({ phase: 'idle' })
  const [account, setAccount] = useState<LoopAccount>()
  const [fee, setFee] = useState<FeeStatus>()
  // the price impact the user accepted for this pair and amount
  const [acceptedImpact, setAcceptedImpact] = useState<number>()
  const swaps = useSwaps(party)

  // swaps left open settle from the balances as they come in
  useEffect(() => {
    if (party && loaded) settleOpenSwaps(party, mine)
  }, [party, loaded, mine])

  useEffect(() => setAcceptedImpact(undefined), [sellId, buyId, raw])

  // default pair: Canton Coin into USDCx (Circle's USDC on Canton), else into
  // the other side of Canton Coin's deepest pool
  useEffect(() => {
    if (!tokens.length || sellId) return
    const base = cc ?? tokens[0]
    const others = tokens.filter((t) => !sameInstrument(t, base))
    const deepest = market.pools
      .filter((p) => sameInstrument(p.a, base) || sameInstrument(p.b, base))
      .sort((x, y) => Number(y.tvlCc) - Number(x.tvlCc))[0]
    const across = deepest && (sameInstrument(deepest.a, base) ? deepest.b : deepest.a)
    setSellId(base)
    setBuyId(others.find((t) => t.symbol === 'USDCx') ?? others.find((t) => !!across && sameInstrument(t, across)) ?? others[0])
  }, [tokens, cc, sellId, market.pools])

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
        if (alive && seq === quoteSeq.current) setQuoteError(e instanceof Error ? e.message.replace(/^(Cantex|OneSwap): /, '') : String(e))
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

  // Loop tells us whether the wallet can receive the output in one step.
  // Asked again every few seconds, so turning it on in Loop shows up here
  // without a reload.
  useEffect(() => {
    setAccount(undefined)
    if (wallet.phase !== 'connected' || !wallet.session.account) return
    const ask = wallet.session.account
    let alive = true
    const read = () => ask().then((a) => alive && setAccount(a), () => {})
    read()
    const id = setInterval(read, 5_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [wallet])

  // Loop asks for a fee top-up in the middle of a transaction and drops the
  // transaction, so ask Loop (nothing signed) whether its fee balance covers
  // this swap, and keep asking so a top-up in Loop shows up here
  const memo = quote?.memo
  const sellAmount = amount > ZERO ? show(amount) : undefined
  const swapParty = NETWORK.cantex?.swapParty
  useEffect(() => {
    setFee(undefined)
    if (wallet.phase !== 'connected' || !wallet.session.fees || !sell || !memo || !sellAmount || !swapParty) return
    const ask = wallet.session.fees
    let alive = true
    const read = async () => {
      const proxy = wallet.session.transferVia ? await orvaneProxy() : undefined
      const f = await ask(proxy, swapParty, sellAmount, sell, memo).catch(() => undefined)
      if (alive) setFee(f)
    }
    read()
    const id = setInterval(read, FEE_CHECK_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
    // sell is re-derived each render; its identity is the instrument
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, sell?.admin, sell?.id, memo, sellAmount, swapParty])

  const pool = sell && buy ? market.poolFor(sell, buy) : undefined
  // each token's deepest pool, for the token picker; Canton Coin is in every pool
  const depthOf = useMemo(() => {
    const deepest = new Map<string, number>()
    for (const p of market.pools) {
      for (const s of [p.a, p.b]) deepest.set(`${s.admin}|${s.id}`, Math.max(deepest.get(`${s.admin}|${s.id}`) ?? 0, Number(p.tvlCc)))
    }
    const all = market.pools.reduce((s, p) => s + Number(p.tvlCc), 0)
    return (t: Token) => (cc && sameInstrument(t, cc) ? all : (deepest.get(`${t.admin}|${t.id}`) ?? 0))
  }, [market.pools, cc])
  const balanceOf = useMemo(() => (party ? (t: Token) => toNumber(free(t)) : undefined), [party, free])
  const check = useMemo(() => (quote && cc ? safeCheck(quote, quotePools ?? market.pools, cc) : undefined), [quote, quotePools, market.pools, cc])
  const age = quote ? now - quote.receivedAt : 0
  const stale = !!quote && age > STALE_MS
  const minOut = quote ? minimumOut(dec(quote.returned.amount), slippage) : ZERO
  const balanceIn = sell ? free(sell) : ZERO
  const insufficient = amount > balanceIn
  const ccMin = policy ? dec(policy.minConnectSwapCc) : ZERO
  const belowMin = !!sell && !!cc && sameInstrument(sell, cc) && amount > ZERO && amount < ccMin
  // Cantex needs a pre-approval for the token it sends back. A Canton Coin
  // pre-approval covers Canton Coin only; other tokens need their own, from
  // their issuer (Loop lists those by instrument admin). OneSwap does not
  // document such a need, so DevNet does not check it.
  const canReceive = !account || !buy || !cc || NETWORK.oneswap ? true : sameInstrument(buy, cc) ? account.hasPreapproval : account.preapprovalAdmins.includes(buy.admin)
  const impact = check?.priceImpactBps ?? 0
  const tooThin = !!check && impact > MAX_IMPACT_BPS
  const steep = !!check && impact > CONFIRM_IMPACT_BPS && !tooThin
  // a tick holds while the impact stays within a point of what was accepted
  const impactOk = !steep || (acceptedImpact !== undefined && impact <= acceptedImpact + 100)
  // a swap the wallet never confirmed can still land; it is worth a look before swapping again
  const unconfirmed = swaps.find((r) => r.status === 'unconfirmed' && Date.now() - r.at < WATCH_MS)
  const busy = tx.phase === 'busy'
  const reference = NETWORK.cantex ? prices[NETWORK.cantex.referenceMarket] : undefined
  // Canton Coin's price in a dollar pool, next to its market price
  const dollarPool = pool && cc && [pool.a, pool.b].some((s) => sameInstrument(s, cc)) && [pool.a.symbol, pool.b.symbol].some((x) => /usd/i.test(x))
  const poolPrice = pool && cc && dollarPool ? poolPriceInCc(pool, cc) : undefined
  const offMarket = poolPrice && reference ? deviationBps(poolPrice, reference.price) : 0
  // a dollar figure under each amount, only where we know one: a USD token
  // counts as a dollar, and CC uses the market reference price
  const usdOf = (t: Token | undefined, n: number): number | undefined =>
    !t || !(n > 0) ? undefined : /usd/i.test(t.symbol) ? n : cc && sameInstrument(t, cc) && reference ? n * reference.price : undefined
  const payNumber = toNumber(amount)
  const getNumber = quote ? toNumber(dec(quote.returned.amount)) : 0
  const payUsd = usdOf(sell, payNumber)
  const getUsd = usdOf(buy, getNumber)
  // the orbs weigh the swap: the left one (what you pay) shrinks and the right
  // one (what you get) grows with its size, by dollar value or else by impact
  const share = !(payNumber > 0) ? 0 : Math.min(1, payUsd !== undefined ? Math.sqrt(payUsd / 2_000) : impact / 300)
  const orbWeights: [number, number] | undefined = share > 0 ? [1 - 0.08 * share, 1 + 0.08 * share] : undefined
  const rate = quote && payNumber > 0 ? getNumber / payNumber : undefined
  const feeShort = !!fee?.topUp && !insufficient && !belowMin
  const disabled = !party || !quote || stale || busy || insufficient || belowMin || !check?.agrees || !canReceive || feeShort || tooThin || !impactOk || amount <= ZERO
  const walletName = wallet.phase === 'connected' ? wallet.session.name : 'your wallet'

  const submit = async () => {
    if (disabled || !quote || !api || !cc || !sell || !buy) return
    const title = `Swap ${fmt(toNumber(amount), 4)} ${sell.symbol} for ${buy.symbol}`
    const id = activity.start(title, 'Checking the price…')
    setTx({ phase: 'busy', stage: 'checking' })
    try {
      const r = await executeSwap(dex, api, quote, {
        slippageBps: slippage,
        cc,
        acceptedImpactBps: steep ? acceptedImpact : undefined,
        onStage: (stage) => {
          setTx({ phase: 'busy', stage })
          activity.update(id, {
            detail:
              stage === 'signing'
                ? 'Sign in your wallet…'
                : stage === 'confirming'
                  ? `${walletName} did not confirm it. Checking whether it was sent…`
                  : stage === 'settling'
                    ? `Sent. ${VENUE} is filling it from its pools…`
                    : 'Checking the price…',
          })
        },
      })
      setTx({ phase: 'done', received: r.received, quoted: r.quoted, outcome: r.status, until: r.at + SWAP_TRANSFER_TTL_MS })
      if (r.status === 'filled') {
        activity.done(id, { detail: `+${fmt(toNumber(r.received), 6)} ${buy.symbol} in your wallet` })
        signalSettled(sell.symbol === 'CC' ? 'CCx' : 'USDx')
        setRaw('')
      } else if (r.status === 'pending') {
        activity.done(id, { detail: NETWORK.oneswap ? 'Sent, not filled yet; this page keeps watching. OneSwap refunds a swap it cannot fill.' : 'Sent, not filled yet; this page keeps watching. If Cantex cannot fill it, cancel the pending transfer in your wallet.' })
      } else {
        activity.done(id, { detail: `${walletName} did not confirm the swap and nothing has left your wallet so far. Check ${walletName} before you swap again.` })
      }
    } catch (e) {
      const message = e instanceof SwapBlocked ? e.message : errorText(e)
      setTx({ phase: 'error', message })
      activity.fail(id, e instanceof SwapBlocked ? e.message : e)
    }
  }

  const reached =
    tx.phase === 'busy'
      ? { checking: 0, signing: 1, confirming: 1, settling: 2 }[tx.stage]
      : tx.phase === 'done'
        ? { filled: 4, pending: 2, unconfirmed: 1 }[tx.outcome]
        : -1
  const symbol = pool?.symbol

  return (
    <div className="page page-trade">
      <div className="narrative">
        <VaultStage scene="trade" weights={orbWeights} />
        <motion.p className="eyebrow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          Swap · {NETWORK.label} · {VENUE} liquidity
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
          <EyeIcon /> Orvane holds nothing and charges nothing. Your wallet sends the swap straight to {VENUE}'s pools; Orvane prices it itself first and
          checks it again just before your wallet opens.
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

            <div className="leg leg-in">
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
                <TokenPicker
                  side="pay"
                  tokens={tokens}
                  value={sell}
                  other={buy}
                  balance={balanceOf}
                  depth={depthOf}
                  onChange={(t) => (buy && sameInstrument(t, buy) ? (setBuyId(sellId), setSellId(t)) : setSellId(t))}
                />
              </div>
              <div className="leg-foot mono">{payUsd !== undefined ? `≈ $${fmt(payUsd, 2)}` : ' '}</div>
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
                <TokenPicker
                  side="receive"
                  tokens={tokens}
                  value={buy}
                  other={sell}
                  balance={balanceOf}
                  depth={depthOf}
                  onChange={(t) => (sell && sameInstrument(t, sell) ? (setSellId(buyId), setBuyId(t)) : setBuyId(t))}
                />
              </div>
              <div className="leg-foot mono">
                {quote && buy ? <>at least {fmt(toNumber(minOut), 6)}{getUsd !== undefined ? ` · ≈ $${fmt(getUsd, 2)}` : ''}</> : ' '}
              </div>
            </div>

            {quoteError && <p className="tx-error">{quoteError}</p>}
            {quote && sell && buy && (
              <div className="terms">
                <p className="mono">
                  {rate !== undefined && (
                    <span>
                      1 {sell.symbol} = {fmt(rate, rate < 0.01 ? 8 : 5)} {buy.symbol}
                    </span>
                  )}
                  <span className={check && check.priceImpactBps > 300 ? 'warn' : check && check.priceImpactBps > 100 ? 'soft-warn' : ''}>
                    impact {check ? fmt(check.priceImpactBps / 100, 2) : '—'}%
                  </span>
                  <span>
                    fees {fmt(toNumber(dec(quote.feePercentage)) * 100, 2)}% + {Number(quote.networkFee.amount)} {market.token(quote.networkFee)?.symbol ?? 'CC'}
                  </span>
                  {check && <span className={check.agrees ? 'ok' : 'warn'}>{check.agrees ? '✓ matches the pools' : `off by ${fmt(check.diffBps / 100, 2)}%`}</span>}
                </p>
                <button className="link" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
                  {showDetails ? 'Less' : 'Details'}
                </button>
              </div>
            )}
            {quote && sell && buy && showDetails && (
              <dl className="details">
                <div>
                  <dt>Route</dt>
                  <dd className="mono route">
                    {routeOf(quote, market.token)}
                    {NETWORK.proxy && <span className="muted"> · sent through Orvane</span>}
                  </dd>
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
                    {fmt(toNumber(dec(quote.feePercentage)) * 100, 2)}% · {Number(quote.networkFee.amount)} {market.token(quote.networkFee)?.symbol ?? 'CC'} network
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
                  <dd className="mono">{Number.isFinite(quote.estimatedSeconds) ? `~${Math.round(quote.estimatedSeconds)} s` : '—'}</dd>
                </div>
              </dl>
            )}
            {offMarket > 1_000 && (
              <p className="tx-warn">
                This pool's price is {fmt(offMarket / 100, 0)}% away from the market price of Canton Coin. You would likely trade at a bad price.
              </p>
            )}
            {belowMin && <p className="tx-warn">{VENUE} fills swaps of at least {fmt(toNumber(ccMin), 0)} CC.</p>}
            {tooThin && (
              <p className="tx-warn">This swap would move the pool's price by {impactText(impact)}: the pool is too thin for this amount. Try a smaller amount.</p>
            )}
            {steep && (
              <div className="tx-warn">
                This swap moves the pool's price by {impactText(impact)}, so you get about that much less than at the pool's current price.
                {party && (
                  <label className="consent">
                    <input type="checkbox" checked={impactOk} onChange={(e) => setAcceptedImpact(e.target.checked ? impact : undefined)} />
                    Swap anyway at {impactText(impact)} price impact
                  </label>
                )}
              </div>
            )}
            {party && unconfirmed && !busy && !(tx.phase === 'done' && tx.outcome === 'unconfirmed') && (
              <p className="tx-warn">
                Your swap of {fmt(Number(unconfirmed.sell.amount), 4)} {market.token(unconfirmed.sell)?.symbol ?? unconfirmed.sell.id} at {clockTime(unconfirmed.at)} is not
                confirmed: {walletName} did not say whether it sent it. If you signed it, it can still go through until {clockTime(unconfirmed.at + SWAP_TRANSFER_TTL_MS)}.
                Check {walletName} before you swap again.
              </p>
            )}
            {party && !canReceive && buy && (
              <div className="tx-warn">
                Your wallet can't receive {buy.symbol} in one step yet. {VENUE ?? 'The venue'} needs that to send the swap back to you.
                {wallet.phase === 'connected' && wallet.session.walletUrl ? (
                  <>
                    {' '}Turn on receiving for {buy.symbol} (a transfer pre-approval) in {wallet.session.name}; this page picks it up by itself.
                    <div className="warn-actions">
                      <a className="ghost small" href={wallet.session.walletUrl} target="_blank" rel="noreferrer">
                        Open {wallet.session.name} ↗
                      </a>
                      <span className="muted small">checking every few seconds…</span>
                    </div>
                  </>
                ) : (
                  <> Turn on receiving for {buy.symbol} (a transfer pre-approval) in your wallet first.</>
                )}
              </div>
            )}
            {party && feeShort && fee && wallet.phase === 'connected' && (
              <div className="tx-warn">
                Your {wallet.session.name} fee balance is too low for this swap{fee.amount ? ` (it needs about ${fee.amount} ${fee.asset ?? 'CC'})` : ''}. Top it up in{' '}
                {wallet.session.name} first, then swap: topping up in the middle of a swap makes {wallet.session.name} drop the swap.
                {wallet.session.walletUrl && (
                  <div className="warn-actions">
                    <a className="ghost small" href={wallet.session.walletUrl} target="_blank" rel="noreferrer">
                      Open {wallet.session.name} ↗
                    </a>
                    <span className="muted small">checking every few seconds…</span>
                  </div>
                )}
              </div>
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
                        : tx.stage === 'confirming'
                          ? 'Checking your wallet…'
                          : 'Filling…'
                    : amount <= ZERO
                      ? 'Enter an amount'
                      : insufficient
                        ? `Not enough ${sell?.symbol}`
                        : belowMin
                          ? 'Below the minimum'
                          : feeShort
                            ? 'Top up your fee balance'
                          : !quote
                            ? quoteError
                              ? 'No quote'
                              : 'Getting a price…'
                            : stale
                              ? 'Updating the price…'
                              : check && !check.agrees
                                ? 'Quote does not match the pools'
                                : tooThin
                                  ? 'Price impact too high'
                                  : !impactOk
                                    ? 'Accept the price impact first'
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
                    {['Price checked twice', 'Signed in your wallet', `Filled from ${VENUE} pools`, 'In your wallet'].map((s, i) => (
                      <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
                        <span className="dot" />
                        {s}
                      </li>
                    ))}
                  </ol>
                )}
                {tx.phase === 'done' && tx.outcome === 'filled' && buy && (
                  <p className="tx-ok mono">
                    +{fmt(toNumber(tx.received), 6)} {buy.symbol}
                    <span className="muted small"> · quoted {fmt(toNumber(tx.quoted), 6)}</span>
                  </p>
                )}
                {tx.phase === 'done' && tx.outcome === 'pending' && (
                  <p className="tx-warn">
                    Sent, not filled yet; this page keeps watching.{' '}{NETWORK.oneswap ? 'OneSwap refunds a swap it cannot fill.' : "If Cantex can't fill it, the transfer stays pending: cancel it in your wallet and your funds come back."}
                  </p>
                )}
                {tx.phase === 'done' && tx.outcome === 'unconfirmed' && (
                  <p className="tx-warn">
                    {walletName} did not say whether it sent the swap, and nothing has left your wallet so far. If you signed it, it can still go through until{' '}
                    {clockTime(tx.until)}; this page keeps watching. Check {walletName} before you swap again.
                  </p>
                )}
              </motion.div>
            )}
          </Tilt>
        </Panel>

        {party && <History rows={swaps} pendingOut={mine.outgoing.filter((o) => o.receiver === NETWORK.cantex?.swapParty).length} />}
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

// this wallet's swaps as this browser keeps them, kept current
function useSwaps(party: string | undefined): SwapRecord[] {
  const [rows, setRows] = useState<SwapRecord[]>(() => (party ? loadSwaps(party) : []))
  useEffect(() => {
    if (!party) {
      setRows([])
      return
    }
    setRows(loadSwaps(party))
    return onSwapsChanged(() => setRows(loadSwaps(party)))
  }, [party])
  return rows
}

function statusText(r: SwapRecord) {
  // past the window the page stops settling it from the balances
  const watched = Date.now() - r.at < WATCH_MS
  switch (r.status) {
    case 'filled':
      return `quoted ${fmt(Number(r.quoted.amount), 6)}`
    case 'pending':
      return watched ? 'sent, not filled yet' : 'no fill seen: check your wallet'
    case 'unconfirmed':
      return watched ? 'not confirmed by your wallet yet' : 'not confirmed: check your wallet'
    case 'failed':
      return 'not sent'
    case 'refunded':
      return 'refunded by OneSwap'
    default:
      return 'sending'
  }
}

function History({ rows, pendingOut }: { rows: SwapRecord[]; pendingOut: number }) {
  const market = useMarket()
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
              <motion.li key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className={r.status === 'failed' || r.status === 'unconfirmed' ? 'warn' : undefined}>
                <span className="mono">
                  {fmt(Number(r.sell.amount), 4)} {sym(r.sell)} → {r.received ? fmt(Number(r.received), 6) : '…'} {sym(r.quoted)}
                </span>
                <span className="muted small">
                  {statusText(r)}
                  {r.route === 'orvane' && ' · via Orvane'}
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
