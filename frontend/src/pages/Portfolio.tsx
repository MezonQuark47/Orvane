// Portfolio: what you hold, what is on its way to you, and your history.
// Every number here is read from your own node through your wallet.

import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { ZERO, toNumber } from '../../../shared/decimal.ts'
import { sameInstrument } from '../../../shared/dex.ts'
import { useDex, type Allocation, type Incoming } from '../ledger/dex.tsx'
import { answerIncoming, takeBack } from '../ledger/orders.ts'
import { VaultStage } from '../three/stage.tsx'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, Panel, Rolling, SkeletonList, TokenIcon, fmt, shortParty } from '../ui/bits.tsx'
import { NETWORK } from '../ledger/network.ts'
import { useMarket } from '../swap/market.tsx'
import { errorText } from '../ui/errors.ts'
import { dateTime } from '../ui/time.ts'

export default function Portfolio() {
  const dex = useDex()
  const { config, pools, party, mine, loaded, instrument } = dex
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined

  const market = useMarket()
  // every token this network trades, plus anything else the wallet holds
  const listed = NETWORK.cantex
    ? market.tokens.map((t) => ({ key: t.symbol, label: t.symbol, admin: t.admin, id: t.id }))
    : Object.entries(config?.instruments ?? {}).map(([key, i]) => ({ key, ...i }))
  const extra = mine.holdings
    .map((h) => h.instrument)
    .filter((i, n, all) => !listed.some((l) => sameInstrument(l, i)) && all.findIndex((x) => sameInstrument(x, i)) === n)
    .map((i) => ({ key: i.id, label: i.id, ...i }))
  const instruments = [...listed, ...extra]
  const totals = instruments.map((i) => {
    const hs = mine.holdings.filter((h) => sameInstrument(h.instrument, i))
    return {
      ...i,
      free: toNumber(hs.filter((h) => !h.locked).reduce((s, h) => s + h.amount, ZERO)),
      locked: toNumber(hs.filter((h) => h.locked).reduce((s, h) => s + h.amount, ZERO)),
    }
  })
  // value everything in Canton Coin at Cantex pool prices (or, on LocalNet,
  // in the Orvane pool's second asset)
  const priceInCc = (i: { admin: string; id: string }) => {
    const cc = market.cc
    if (!cc) return 0
    if (sameInstrument(i, cc)) return 1
    const p = market.poolFor(i, cc)
    if (!p) return 0
    const [ccSide, other] = sameInstrument(p.a, cc) ? [Number(p.reserveA), Number(p.reserveB)] : [Number(p.reserveB), Number(p.reserveA)]
    return other > 0 ? ccSide / other : 0
  }
  const priceOf = (i: { admin: string; id: string }) => {
    if (NETWORK.cantex) return priceInCc(i)
    if (!pool || !live || live.reserveA === ZERO) return 0
    if (sameInstrument(i, pool.instrumentB)) return 1
    if (sameInstrument(i, pool.instrumentA)) return toNumber(live.reserveB) / toNumber(live.reserveA)
    return 0
  }
  const unit = NETWORK.cantex ? 'CC' : pool ? instrument(pool.instrumentB).label : ''
  const ccUsd = NETWORK.cantex ? market.prices[NETWORK.cantex.referenceMarket]?.price : undefined
  const worth = totals.reduce((s, t) => s + (t.free + t.locked) * priceOf(t), 0)

  if (!party) {
    return (
      <div className="page page-holdings">
        <div className="narrative">
          <VaultStage scene="holdings" />
          <p className="eyebrow">Portfolio</p>
          <h1 className="display">
            <span className="line">Everything you hold,</span>
            <span className="line accent">
              <em>in one place.</em>
            </span>
          </h1>
          <p className="lede">Connect a wallet to see what it holds at live pool prices, with your pending swaps and incoming transfers.</p>
        </div>
        <div className="rail">
          <Panel delay={0.15}>
            <ConnectFirst what="see your portfolio" />
          </Panel>
        </div>
      </div>
    )
  }

  return (
    <div className="page page-holdings">
      <div className="narrative">
        <VaultStage scene="holdings" />
        <p className="eyebrow">Portfolio · {shortParty(party)}</p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Everything you hold,
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>in one place.</em>
          </motion.span>
        </h1>
        <div className="networth">
          <span className="muted small">{NETWORK.cantex ? 'Total value, at Cantex pool prices' : 'Total value, at the pool price'}</span>
          <div>
            <Rolling value={worth} digits={4} className="big mono" /> <span className="unit">{unit}</span>
          </div>
          {ccUsd !== undefined && worth > 0 && <span className="muted small mono">≈ {fmt(worth * ccUsd, 2)} USD at Canton Coin's market price</span>}
        </div>
        <div className="balances">
          {totals.map((t, n) => (
            <motion.div key={t.key} className="balance-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + n * 0.08 }}>
              <TokenIcon symbol={t.label} size={34} />
              <div>
                <Rolling value={t.free} digits={4} className="mono strong" />
                <span className="muted small">
                  {t.key} free{t.locked > 0 ? ` · ${fmt(t.locked, 4)} locked` : ''}
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <div className="rail">
        <PendingSwapsPanel />
        <IncomingPanel items={mine.incoming} />
        {NETWORK.pool && <EndedPanel items={mine.allocations} />}
        <BridgePanel />

        {NETWORK.pool && (
          <Panel delay={0.25}>
            <header className="card-head">
              <h3>History</h3>
              <span className="muted small">your pool trades and positions</span>
            </header>
            <History />
          </Panel>
        )}

        <Panel delay={0.35}>
          <header className="card-head">
            <h3>Holding contracts</h3>
            <span className="muted small">{mine.holdings.length}</span>
          </header>
          <ul className="holding-list">
            {mine.holdings.map((h) => {
              const label = market.token(h.instrument)?.symbol ?? instrument(h.instrument).label
              return (
                <li key={h.cid}>
                  <TokenIcon symbol={label} size={20} />
                  <span className="mono strong">{fmt(toNumber(h.amount), 4)}</span>
                  <span className="muted">{label}</span>
                  <span className="obs small">{h.locked ? 'locked in an allocation' : 'free'}</span>
                </li>
              )
            })}
            {mine.holdings.length === 0 && (loaded ? <li className="empty">No holdings yet.</li> : <li className="empty"><SkeletonList rows={2} /></li>)}
          </ul>
          {config?.network === 'localnet' && mine.holdings.length === 0 && loaded && (
            <p className="muted small">
              On LocalNet, test funds arrive as transfer offers: run <code>./scripts/fund-localnet.ps1 -Party {'<your party>'}</code> and accept them above.
            </p>
          )}
        </Panel>
      </div>
    </div>
  )
}

function IncomingPanel({ items }: { items: Incoming[] }) {
  const dex = useDex()
  const market = useMarket()
  const activity = useActivity()
  const [busy, setBusy] = useState<string>()
  if (!items.length) return null
  const answer = async (i: Incoming, accept: boolean) => {
    const label = dex.instrument(i.instrument).label
    setBusy(i.cid)
    try {
      await activity.track(`${accept ? 'Accept' : 'Decline'} ${fmt(toNumber(i.amount), 4)} ${label}`, () => answerIncoming(dex, i.cid, i.instrument.admin, accept), {
        detail: 'Waiting for your signature…',
        done: () => ({ detail: accept ? `${fmt(toNumber(i.amount), 4)} ${label} is in your account.` : 'Sent back to the sender.' }),
      })
    } catch {
      /* reported in Activity */
    }
    setBusy(undefined)
  }
  return (
    <Panel delay={0.15} className="incoming">
      <header className="card-head">
        <h3>Incoming</h3>
        <span className="badge">{items.length} to accept</span>
      </header>
      <ul className="holding-list">
        <AnimatePresence initial={false}>
          {items.map((i) => {
            const label = market.token(i.instrument)?.symbol ?? dex.instrument(i.instrument).label
            return (
              <motion.li key={i.cid} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }}>
                <TokenIcon symbol={label} size={20} />
                <span className="mono strong">{fmt(toNumber(i.amount), 4)}</span>
                <span className="muted">{label}</span>
                <span className="obs small">from {i.sender ? shortParty(i.sender) : 'the registry'}</span>
                {/* accepting needs the token's registry, which Orvane only reaches where it runs one (LocalNet) */}
                {NETWORK.pool && (
                  <span className="row-actions">
                    <button className="ghost small" disabled={!!busy} onClick={() => answer(i, true)}>
                      {busy === i.cid ? '…' : 'Accept'}
                    </button>
                    <button className="link small" disabled={!!busy} onClick={() => answer(i, false)}>
                      Decline
                    </button>
                  </span>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      {!NETWORK.pool && <p className="muted small">Accept or decline these in your wallet.</p>}
    </Panel>
  )
}

// Liquidity whose term is over. The operator releases it on its way out
// while it is running; if it is not, the owner takes it back with their own
// signature, and assets whose registry expires allocations come back alone.
function EndedPanel({ items }: { items: Allocation[] }) {
  const dex = useDex()
  const activity = useActivity()
  const [busy, setBusy] = useState<string>()
  const now = Date.now()
  const ended = items.filter((a) => a.committed && a.deadline && Date.parse(a.deadline) < now)
  if (!ended.length) return null
  const label = (id: string) => (id === 'Amulet' ? 'CC' : id)
  return (
    <Panel delay={0.2} className="incoming">
      <header className="card-head">
        <h3>Term over</h3>
        <span className="badge">{ended.length} to take back</span>
      </header>
      <ul className="holding-list">
        {ended.map((a) => {
          const what = Object.entries(a.funding ?? {})
            .map(([id, v]) => `${fmt(+v, 4)} ${label(id)}`)
            .join(' + ')
          return (
            <li key={a.cid}>
              <span className="mono strong">{what || 'allocation'}</span>
              <span className="obs small">ended {dateTime(a.deadline!)}</span>
              <span className="row-actions">
                <button
                  className="ghost small"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(a.cid)
                    try {
                      await activity.track(`Take back ${what}`, () => takeBack(dex, a.cid, a.admin), {
                        detail: 'Only your signature is needed.',
                        done: () => ({ detail: `${what} is free in your account.` }),
                      })
                    } catch {
                      /* reported in Activity */
                    }
                    setBusy(undefined)
                  }}
                >
                  {busy === a.cid ? '…' : 'Take back'}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
      <p className="muted small">Your term ended. These funds are yours to unlock with your own signature, whether or not Orvane is running.</p>
    </Panel>
  )
}

type Entry = { key: string; at: number; title: string; detail: string; tone?: 'warn' }

function History() {
  const { mine, loaded, instrument } = useDex()
  const entries: Entry[] = [
    ...mine.receipts.map((r) => ({
      key: r.contractId,
      at: Date.parse(r.payload.settledAt),
      title: `${fmt(+r.payload.amountIn, 4)} ${instrument(r.payload.instrumentIn).label} → ${fmt(+r.payload.amountOut, 4)} ${instrument(r.payload.instrumentOut).label}`,
      detail: 'swap',
    })),
    ...mine.closed.map((c) => ({
      key: c.contractId,
      at: Date.parse(c.payload.closedAt),
      title: `${fmt(+c.payload.amountA, 4)} ${instrument(c.payload.instrumentA).label} + ${fmt(+c.payload.amountB, 4)} ${instrument(c.payload.instrumentB).label}`,
      detail: c.payload.reason === 'Withdrawn' ? 'liquidity withdrawn' : 'term ended, funds unlocked',
    })),
    ...mine.rejections.map((r) => ({
      key: r.contractId,
      at: Number.NaN,
      title: r.payload.reason,
      detail: `handed back · ${r.payload.requestId.split('-')[0]}`,
      tone: 'warn' as const,
    })),
  ].sort((x, y) => (Number.isNaN(y.at) ? -1 : Number.isNaN(x.at) ? 1 : y.at - x.at))

  if (!entries.length) return loaded ? <p className="empty">Nothing yet.</p> : <SkeletonList rows={3} />
  return (
    <ul className="receipt-list history">
      {entries.slice(0, 12).map((e) => (
        <li key={e.key} className={e.tone}>
          <span className="mono">{e.title}</span>
          <span className="muted small">{e.detail}</span>
          <span className="cid mono">{Number.isNaN(e.at) ? '' : dateTime(new Date(e.at))}</span>
        </li>
      ))}
    </ul>
  )
}

// Swaps sent to Cantex that it has not filled yet. Cantex leaves a swap it
// cannot fill pending; the wallet that sent it can withdraw it.
function PendingSwapsPanel() {
  const { mine } = useDex()
  const market = useMarket()
  const swapParty = NETWORK.cantex?.swapParty
  const pending = mine.outgoing.filter((o) => o.receiver === swapParty)
  if (!pending.length) return null
  return (
    <Panel delay={0.12} className="incoming">
      <header className="card-head">
        <h3>Not filled yet</h3>
        <span className="badge">{pending.length}</span>
      </header>
      <ul className="holding-list">
        {pending.map((o) => {
          const label = market.token(o.instrument)?.symbol ?? o.instrument.id
          return (
            <li key={o.cid}>
              <TokenIcon symbol={label} size={20} />
              <span className="mono strong">{fmt(toNumber(o.amount), 4)}</span>
              <span className="muted">{label}</span>
              <span className="obs small">until {dateTime(o.executeBefore)}</span>
            </li>
          )
        })}
      </ul>
      <p className="muted small">Cantex hasn't filled these swaps. Withdraw the pending transfer in your wallet to get the funds back, or wait for it to expire.</p>
    </Panel>
  )
}

// Loop's USDC bridge: send USDCx out to an Ethereum address as USDC. Shown
// only to wallets whose bridge access Loop has granted.
function BridgePanel() {
  const { wallet, free } = useDex()
  const market = useMarket()
  const activity = useActivity()
  const session = wallet.phase === 'connected' ? wallet.session : undefined
  const [granted, setGranted] = useState(false)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const usdcx = market.tokens.find((t) => t.symbol === 'USDCx')

  useEffect(() => {
    setGranted(false)
    session?.account?.().then((a) => setGranted(a.usdcBridge === 'granted'), () => setGranted(false))
  }, [session])

  if (!session?.bridgeUsdcx || !granted || !usdcx) return null
  const balance = toNumber(free(usdcx))
  const valid = /^0x[0-9a-fA-F]{40}$/.test(to) && Number(amount) > 0 && Number(amount) <= balance
  const send = async () => {
    if (!valid) return
    setBusy(true)
    setError(undefined)
    try {
      await activity.track(`Send ${amount} USDCx to Ethereum`, () => session.bridgeUsdcx!(to, amount), {
        detail: 'Sign in Loop…',
        done: () => ({ detail: `Bridging to ${to.slice(0, 8)}…; it arrives as USDC on Ethereum.` }),
      })
      setAmount('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel delay={0.3}>
      <header className="card-head">
        <h3>Send USDCx to Ethereum</h3>
        <span className="muted small">through Loop's USDC bridge</span>
      </header>
      <div className="bridge-form">
        <input className="mono" placeholder="0x… Ethereum address" value={to} onChange={(e) => setTo(e.target.value.trim())} aria-label="Ethereum address" />
        <input className="mono" inputMode="decimal" placeholder={`amount (you have ${fmt(balance, 2)})`} value={amount} onChange={(e) => /^\d*\.?\d{0,6}$/.test(e.target.value) && setAmount(e.target.value)} aria-label="USDCx amount" />
        <button className="ghost small" disabled={!valid || busy} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && <p className="tx-error">{error}</p>}
    </Panel>
  )
}
