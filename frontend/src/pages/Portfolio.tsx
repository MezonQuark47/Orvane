// Portfolio: what you hold, what is on its way to you, and your history.
// Every number here is read from your own node through your wallet.

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { ZERO, toNumber } from '../../../shared/decimal.ts'
import { sameInstrument } from '../../../shared/dex.ts'
import { useDex, type Incoming } from '../ledger/dex.tsx'
import { answerIncoming } from '../ledger/orders.ts'
import { VaultStage } from '../three/stage.tsx'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, Panel, Rolling, SkeletonList, TokenGlyph, fmt, glyphFor, shortParty } from '../ui/bits.tsx'
import { dateTime } from '../ui/time.ts'

export default function Portfolio() {
  const dex = useDex()
  const { config, pools, party, mine, loaded, instrument } = dex
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined

  const instruments = Object.entries(config?.instruments ?? {}).map(([key, i]) => ({ key, ...i }))
  const totals = instruments.map((i) => {
    const hs = mine.holdings.filter((h) => sameInstrument(h.instrument, i))
    return {
      ...i,
      free: toNumber(hs.filter((h) => !h.locked).reduce((s, h) => s + h.amount, ZERO)),
      locked: toNumber(hs.filter((h) => h.locked).reduce((s, h) => s + h.amount, ZERO)),
    }
  })
  // value everything in the pool's second asset, at the pool price
  const priceOf = (i: { admin: string; id: string }) => {
    if (!pool || !live || live.reserveA === ZERO) return 0
    if (sameInstrument(i, pool.instrumentB)) return 1
    if (sameInstrument(i, pool.instrumentA)) return toNumber(live.reserveB) / toNumber(live.reserveA)
    return 0
  }
  const unit = pool ? instrument(pool.instrumentB).label : ''
  const worth = totals.reduce((s, t) => s + (t.free + t.locked) * priceOf(t), 0)

  if (!party) {
    return (
      <div className="page page-holdings">
        <div className="narrative">
          <VaultStage scene="holdings" />
          <p className="eyebrow">Portfolio</p>
          <h1 className="display">
            <span className="line">Yours, and</span>
            <span className="line accent">
              <em>only yours.</em>
            </span>
          </h1>
          <p className="lede">Connect a wallet to see your holdings, positions and trades. They are read from your own node; Orvane never stores them.</p>
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
            Yours, and
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>only yours.</em>
          </motion.span>
        </h1>
        <div className="networth">
          <span className="muted small">Total value, at the pool price</span>
          <div>
            <Rolling value={worth} digits={4} className="big mono" /> <span className="unit">{unit}</span>
          </div>
        </div>
        <div className="balances">
          {totals.map((t, n) => (
            <motion.div key={t.key} className="balance-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + n * 0.08 }}>
              <TokenGlyph symbol={glyphFor(t.key)} size={34} />
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
        <IncomingPanel items={mine.incoming} />

        <Panel delay={0.25}>
          <header className="card-head">
            <h3>History</h3>
            <span className="muted small">records only you and the operator hold</span>
          </header>
          <History />
        </Panel>

        <Panel delay={0.35}>
          <header className="card-head">
            <h3>Holding contracts</h3>
            <span className="muted small">{mine.holdings.length}</span>
          </header>
          <ul className="holding-list">
            {mine.holdings.map((h) => {
              const i = instrument(h.instrument)
              return (
                <li key={h.cid}>
                  <TokenGlyph symbol={glyphFor(i.key)} size={20} />
                  <span className="mono strong">{fmt(toNumber(h.amount), 4)}</span>
                  <span className="muted">{i.label}</span>
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
            const label = dex.instrument(i.instrument).label
            return (
              <motion.li key={i.cid} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }}>
                <TokenGlyph symbol={glyphFor(label)} size={20} />
                <span className="mono strong">{fmt(toNumber(i.amount), 4)}</span>
                <span className="muted">{label}</span>
                <span className="obs small">from {i.sender ? shortParty(i.sender) : 'the registry'}</span>
                <span className="row-actions">
                  <button className="ghost small" disabled={!!busy} onClick={() => answer(i, true)}>
                    {busy === i.cid ? '…' : 'Accept'}
                  </button>
                  <button className="link small" disabled={!!busy} onClick={() => answer(i, false)}>
                    Decline
                  </button>
                </span>
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
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
