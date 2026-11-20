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

type Row = { key: string; kind: string; title: string; detail: string }

export default function Privacy() {
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
