import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { T, type LpShare, type Pool, type SwapReceipt, type Token } from '../../../shared/amm.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { useOrvane, type Persona } from '../ledger/OrvaneProvider.tsx'
import { EyeIcon, fmt, fmtCompact } from '../ui/bits.tsx'

type Row = { cid: string; kind: string; title: string; detail: string }

const ALL = [T.Token, T.Pool, T.LpShare, T.SwapReceipt, T.SwapRequest]

function describe(c: Contract<unknown>, self: string): Row {
  const kind = c.templateId.split(':').pop()!
  const p = c.payload as Record<string, unknown>
  switch (kind) {
    case 'Token': {
      const t = p as unknown as Token
      const mine = t.owner === self
      return { cid: c.contractId, kind, title: `${fmt(+t.amount)} ${t.symbol}`, detail: mine ? 'holding' : `held by ${t.owner.split('::')[0]}` }
    }
    case 'Pool': {
      const pl = p as unknown as Pool
      return { cid: c.contractId, kind, title: `Pool ${pl.poolId}`, detail: `${fmtCompact(+pl.reserveA)} USDx · ${fmtCompact(+pl.reserveB)} CCx` }
    }
    case 'LpShare': {
      const l = p as unknown as LpShare
      return { cid: c.contractId, kind, title: `${fmt(+l.shares)} LP shares`, detail: l.poolId }
    }
    case 'SwapReceipt': {
      const r = p as unknown as SwapReceipt
      return { cid: c.contractId, kind, title: `${fmt(+r.amountIn)} ${r.symbolIn} → ${fmt(+r.amountOut, 2)} ${r.symbolOut}`, detail: 'trade receipt' }
    }
    default:
      return { cid: c.contractId, kind, title: kind, detail: 'pending' }
  }
}

function useView(persona: Persona) {
  const { ledger } = useOrvane()
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const cs = await ledger.query<unknown>(persona.party, ALL)
        if (alive) setRows(cs.map((c) => describe(c, persona.party)).sort((a, b) => order(a.kind) - order(b.kind)))
      } catch {
        /* keep last view */
      }
      if (alive) timer = setTimeout(tick, 1500)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ledger, persona.party])
  return rows
}

const order = (k: string) => ['Pool', 'SwapReceipt', 'SwapRequest', 'LpShare', 'Token'].indexOf(k)

export default function Lens() {
  const { config, persona } = useOrvane()
  if (!config) return null
  return (
    <div className="page page-lens">
      <header className="lens-head">
        <p className="eyebrow">Privacy lens · live</p>
        <h1 className="display small">
          One ledger, <em>three truths.</em>
        </h1>
        <p className="lede">
          These are the contracts each participant's node actually holds right now. Make a trade as one persona and watch the other columns:
          they see the pool move, and nothing about you.
        </p>
      </header>
      <div className="lens-grid">
        {config.personas.map((p, i) => (
          <Column key={p.key} persona={p} index={i} active={p.key === persona?.key} />
        ))}
      </div>
    </div>
  )
}

function Column({ persona, index, active }: { persona: Persona; index: number; active: boolean }) {
  const rows = useView(persona)
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {})
  return (
    <motion.section
      className={`lens-col ${active ? 'active' : ''}`}
      initial={{ opacity: 0, y: 30, rotateY: index === 0 ? 10 : index === 2 ? -10 : 0 }}
      animate={{ opacity: 1, y: 0, rotateY: 0 }}
      transition={{ duration: 0.8, delay: 0.1 + index * 0.1, ease: [0.16, 1, 0.3, 1] }}
    >
      <header>
        <span className={`avatar av-${persona.key}`}>{persona.name[0]}</span>
        <div>
          <h3>{persona.name}</h3>
          <span className="muted small">{persona.role}</span>
        </div>
        <span className="count mono">{rows.length}</span>
      </header>
      <div className="lens-tags">
        {Object.entries(counts).map(([k, n]) => (
          <span key={k} className={`tag tag-${k}`}>
            {k} {n}
          </span>
        ))}
      </div>
      <ul>
        <AnimatePresence initial={false}>
          {rows.slice(0, 14).map((r) => (
            <motion.li
              key={r.cid}
              layout
              className={`lens-row k-${r.kind}`}
              initial={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, scale: 0.96, filter: 'blur(8px)' }}
              transition={{ duration: 0.45 }}
            >
              <span className="k">{r.kind}</span>
              <span className="t mono">{r.title}</span>
              <span className="d">{r.detail}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {rows.length > 14 && <li className="more muted small">+{rows.length - 14} more</li>}
      </ul>
      <footer className="veil">
        <EyeIcon closed /> Everything else on this ledger is invisible to {persona.name}.
      </footer>
    </motion.section>
  )
}
