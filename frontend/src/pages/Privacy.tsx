// Privacy: the same market, seen from two places.
//
// Left: what your own node holds, read live through your wallet. Right:
// everything anyone else can learn from Orvane, which is exactly what the
// operator's public API serves. Below: proof from your own allocations that
// the only counterparty they ever name is the operator.

import { AnimatePresence, motion } from 'motion/react'
import { toNumber } from '../../../shared/decimal.ts'
import { useDex } from '../ledger/dex.tsx'
import { ConnectFirst, EyeIcon, fmt, fmtCompact, shortParty } from '../ui/bits.tsx'
import { NETWORK } from '../ledger/network.ts'
import { useMarket } from '../swap/market.tsx'

type Row = { key: string; kind: string; title: string; detail: string }

export default function Privacy() {
  return NETWORK.cantex ? <SwapPrivacy /> : <PoolPrivacy />
}

function PoolPrivacy() {
  const { config, pools, party, mine, instrument } = useDex()
  const allocations = mine.allocations
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined

  const mineRows: Row[] = [
    ...mine.positions.map((p) => ({
      key: p.contractId,
      kind: 'Position',
      title: `${fmt(+p.payload.amountA, 2)} ${instrument(p.payload.instrumentA).label} + ${fmt(+p.payload.amountB, 2)} ${instrument(p.payload.instrumentB).label}`,
      detail: 'your liquidity, you + operator',
    })),
    ...mine.receipts.map((r) => ({
      key: r.contractId,
      kind: 'Receipt',
      title: `${fmt(+r.payload.amountIn, 2)} ${instrument(r.payload.instrumentIn).label} → ${fmt(+r.payload.amountOut, 2)} ${instrument(r.payload.instrumentOut).label}`,
      detail: 'your trade, you + operator',
    })),
    ...allocations.map((a) => ({
      key: a.cid,
      kind: 'Allocation',
      title: a.funding
        ? Object.entries(a.funding)
            .map(([id, v]) => `${fmt(+v, 2)} ${id === 'Amulet' ? 'CC' : id}`)
            .join(' + ')
        : `${a.counterparties.length} leg(s)`,
      detail: `${a.committed ? 'committed' : 'one-shot'} · ${a.settlements} settlements`,
    })),
    ...mine.holdings.map((h) => ({
      key: h.cid,
      kind: 'Holding',
      title: `${fmt(toNumber(h.amount), 2)} ${instrument(h.instrument).label}`,
      detail: h.locked ? 'locked for the pool' : 'in your account',
    })),
  ]

  // every counterparty named in any of your allocations
  const counterparties = new Set(allocations.flatMap((a) => a.counterparties.map((p) => p ?? 'registry')))
  const executors = new Set(allocations.flatMap((a) => a.executors))

  return (
    <div className="page page-lens">
      <header className="lens-head">
        <p className="eyebrow">Privacy · live</p>
        <h1 className="display small">
          One market, <em>two views.</em>
        </h1>
        <p className="lede">
          Canton only sends a party the parts of a transaction it is a stakeholder in. On the left is what your node holds right now, read through
          your wallet. On the right is everything anyone else can learn about the pool. Trade, then watch both.
        </p>
      </header>

      <div className="lens-grid two">
        <motion.section className="lens-col active" initial={{ opacity: 0, y: 30, rotateY: 8 }} animate={{ opacity: 1, y: 0, rotateY: 0 }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}>
          <header>
            <span className="avatar">Y</span>
            <div>
              <h3>Your node</h3>
              <span className="muted small">{party ? shortParty(party) : 'not connected'}</span>
            </div>
            <span className="count mono">{mineRows.length}</span>
          </header>
          {!party ? (
            <div className="lens-empty">
              <ConnectFirst what="see what your node holds" />
            </div>
          ) : (
            <ul>
              <AnimatePresence initial={false}>
                {mineRows.slice(0, 16).map((r) => (
                  <motion.li key={r.key} layout className={`lens-row k-${r.kind}`} initial={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}>
                    <span className="k">{r.kind}</span>
                    <span className="t mono">{r.title}</span>
                    <span className="d">{r.detail}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
              {mineRows.length > 16 && <li className="more muted small">+{mineRows.length - 16} more</li>}
              {mineRows.length === 0 && <li className="more muted small">Nothing yet. Swap or add liquidity and it appears here.</li>}
            </ul>
          )}
          <footer className="veil">
            <EyeIcon /> Only you and the operator hold these.
          </footer>
        </motion.section>

        <motion.section className="lens-col" initial={{ opacity: 0, y: 30, rotateY: -8 }} animate={{ opacity: 1, y: 0, rotateY: 0 }} transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}>
          <header>
            <span className="avatar org">§</span>
            <div>
              <h3>Everyone else</h3>
              <span className="muted small">other traders, other LPs, the public</span>
            </div>
            <span className="count mono">{live ? 3 : 0}</span>
          </header>
          <ul>
            {pool && live && (
              <>
                <li className="lens-row k-Pool">
                  <span className="k">Pool</span>
                  <span className="t mono">
                    {fmtCompact(toNumber(live.reserveA))} {instrument(pool.instrumentA).label} · {fmtCompact(toNumber(live.reserveB))} {instrument(pool.instrumentB).label}
                  </span>
                  <span className="d">reserves, as any AMM publishes them</span>
                </li>
                <li className="lens-row k-Pool">
                  <span className="k">Prices</span>
                  <span className="t mono">{live.recent.length} recent fills</span>
                  <span className="d">time, price and size, no parties</span>
                </li>
                <li className="lens-row k-Pool">
                  <span className="k">Count</span>
                  <span className="t mono">{live.positions} providers</span>
                  <span className="d">how many, never who or how much</span>
                </li>
              </>
            )}
          </ul>
          <footer className="veil">
            <EyeIcon closed /> Not your trades, not your positions, not your party.
          </footer>
        </motion.section>
      </div>

      {party && allocations.length > 0 && (
        <motion.section className="panel proof" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
          <header className="card-head">
            <h3>Checked on your node</h3>
            <span className="muted small">{allocations.length} allocations read through your wallet</span>
          </header>
          <dl className="details">
            <div>
              <dt>Settled only by</dt>
              <dd className="mono">{[...executors].map((p) => (p === config?.operator ? 'Orvane operator' : shortParty(p))).join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Counterparties named</dt>
              <dd className="mono">
                {counterparties.size === 0 ? 'none (liquidity only)' : [...counterparties].map((p) => (p === config?.operator ? 'Orvane operator' : shortParty(p))).join(', ')}
              </dd>
            </div>
            <div>
              <dt>Other traders or LPs named</dt>
              <dd className="mono">{[...counterparties].filter((p) => p !== config?.operator).length}</dd>
            </div>
          </dl>
        </motion.section>
      )}
    </div>
  )
}

// Swaps through Cantex: who sees what, said plainly, next to what your own
// node holds right now.
const WHO_SEES: Array<{ who: string; sees: string; not: string }> = [
  {
    who: 'Orvane',
    sees: 'Nothing. No account, no server that sees your swaps; your swap list lives in this browser.',
    not: 'Your party, your balances, your trades',
  },
  {
    who: 'Cantex',
    sees: 'The transfer you send to its swap party (your party, the token and amount) and the swap it fills.',
    not: 'Anything else in your wallet',
  },
  {
    who: "The token's registry",
    sees: 'Transfers of its own token, as with any Canton token.',
    not: 'Other tokens, other trades',
  },
  {
    who: 'Everyone else',
    sees: "Cantex's pool reserves, prices and aggregate volumes. Canton never broadcasts your transaction.",
    not: 'That you traded, how much, or your party',
  },
]

function SwapPrivacy() {
  const { party, mine } = useDex()
  const market = useMarket()
  const label = (i: { admin: string; id: string }) => market.token(i)?.symbol ?? i.id
  const rows = [
    ...mine.outgoing.map((o) => ({ key: o.cid, kind: 'Pending', title: `${fmt(toNumber(o.amount), 4)} ${label(o.instrument)}`, detail: 'sent, not taken yet' })),
    ...mine.incoming.map((o) => ({ key: o.cid, kind: 'Incoming', title: `${fmt(toNumber(o.amount), 4)} ${label(o.instrument)}`, detail: 'waiting for you to accept' })),
    ...mine.holdings.map((h) => ({ key: h.cid, kind: 'Holding', title: `${fmt(toNumber(h.amount), 4)} ${label(h.instrument)}`, detail: h.locked ? 'locked' : 'in your account' })),
  ]
  return (
    <div className="page page-lens">
      <header className="lens-head">
        <p className="eyebrow">Privacy · {NETWORK.label}</p>
        <h1 className="display small">
          Nothing to hide, <em>nothing kept.</em>
        </h1>
        <p className="lede">
          Canton only sends a party the parts of a transaction it is part of. When you swap through Orvane, your wallet sends the transfer to Cantex
          directly; Orvane is not in the transaction at all. Here is who sees what, and what your own node holds right now.
        </p>
      </header>

      <div className="lens-grid two">
        <motion.section className="lens-col active" initial={{ opacity: 0, y: 30, rotateY: 8 }} animate={{ opacity: 1, y: 0, rotateY: 0 }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}>
          <header>
            <span className="avatar">Y</span>
            <div>
              <h3>Your node</h3>
              <span className="muted small">{party ? shortParty(party) : 'not connected'}</span>
            </div>
            <span className="count mono">{rows.length}</span>
          </header>
          {!party ? (
            <div className="lens-empty">
              <ConnectFirst what="see what your node holds" />
            </div>
          ) : (
            <ul>
              <AnimatePresence initial={false}>
                {rows.slice(0, 16).map((r) => (
                  <motion.li key={r.key} layout className={`lens-row k-${r.kind}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                    <span className="k">{r.kind}</span>
                    <span className="t mono">{r.title}</span>
                    <span className="d">{r.detail}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
              {rows.length === 0 && <li className="more muted small">Nothing yet.</li>}
            </ul>
          )}
          <footer className="veil">
            <EyeIcon /> Read through your wallet. Orvane stores none of it.
          </footer>
        </motion.section>

        <motion.section className="lens-col" initial={{ opacity: 0, y: 30, rotateY: -8 }} animate={{ opacity: 1, y: 0, rotateY: 0 }} transition={{ duration: 0.8, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}>
          <header>
            <span className="avatar org">§</span>
            <div>
              <h3>Who sees a swap</h3>
              <span className="muted small">and who does not</span>
            </div>
          </header>
          <ul>
            {WHO_SEES.map((w) => (
              <li key={w.who} className="lens-row k-Pool">
                <span className="k">{w.who}</span>
                <span className="t">{w.sees}</span>
                <span className="d">not: {w.not}</span>
              </li>
            ))}
          </ul>
          <footer className="veil">
            <EyeIcon closed /> {market.pools.length} Cantex pools · prices public, trades not.
          </footer>
        </motion.section>
      </div>
    </div>
  )
}
