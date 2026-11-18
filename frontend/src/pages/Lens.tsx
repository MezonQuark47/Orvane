import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { T, type LpShare, type Pool, type SwapReceipt, type Token } from '../../../shared/amm.ts'
import { P, type Invoice, type PayoutPreference, type PayrollAttestation, type Payslip } from '../../../shared/payments.ts'
import {
  L,
  type Advance,
  type AdvanceLine,
  type AdvanceRepaid,
  type LendingMarket,
  type Loan,
  type LoanClosed,
  type SupplyPosition,
} from '../../../shared/lending.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { useOrvane, type Persona } from '../ledger/OrvaneProvider.tsx'
import { EyeIcon, fmt, fmtCompact } from '../ui/bits.tsx'

type Row = { cid: string; kind: string; title: string; detail: string }

const ALL = [
  T.Token,
  T.Pool,
  T.LpShare,
  T.SwapReceipt,
  T.SwapRequest,
  P.Payslip,
  P.PayrollAttestation,
  P.PayoutRequest,
  P.PayoutPreference,
  P.Invoice,
  P.PaidInvoice,
  P.DisputedInvoice,
  P.InvoiceSettlement,
  L.LendingMarket,
  L.SupplyPosition,
  L.Loan,
  L.LoanClosed,
  L.AdvanceLine,
  L.Advance,
  L.AdvanceRepaid,
]

const short = (party: string) => party.split('::')[0]

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
    case 'Payslip': {
      const s = p as unknown as Payslip
      return { cid: c.contractId, kind, title: `${fmt(+s.received)} ${s.receivedSymbol}`, detail: `${short(s.employee)} · ${s.period}` }
    }
    case 'PayrollAttestation': {
      const a = p as unknown as PayrollAttestation
      return { cid: c.contractId, kind: 'Attestation', title: `${fmt(+a.total)} ${a.symbol} · ${a.headcount} people`, detail: a.period }
    }
    case 'PayoutPreference': {
      const pr = p as unknown as PayoutPreference
      return { cid: c.contractId, kind: 'Preference', title: `${short(pr.employee)} → ${pr.symbol}`, detail: 'payout currency' }
    }
    case 'Invoice':
    case 'PaidInvoice':
    case 'DisputedInvoice':
    case 'InvoiceSettlement': {
      const inv = p as unknown as Invoice
      const state = { Invoice: 'open', PaidInvoice: 'paid', DisputedInvoice: 'disputed', InvoiceSettlement: 'converting' }[kind]
      return {
        cid: c.contractId,
        kind,
        title: `${inv.terms.invoiceNo} · ${fmt(+inv.terms.amount)} ${inv.terms.symbol}`,
        detail: `${short(inv.supplier)} → ${short(inv.buyer)} · ${state}`,
      }
    }
    case 'PayoutRequest': {
      const r = p as unknown as { employee: string; gross: string; receiveSymbol: string }
      return { cid: c.contractId, kind, title: `${fmt(+r.gross)} USDx → ${r.receiveSymbol}`, detail: `for ${short(r.employee)}` }
    }
    case 'LendingMarket': {
      const m = p as unknown as LendingMarket
      return { cid: c.contractId, kind: 'Market', title: `${fmtCompact(+m.cash + +m.principalOut)} supplied`, detail: `${fmtCompact(+m.principalOut)} borrowed · totals only` }
    }
    case 'SupplyPosition': {
      const s = p as unknown as SupplyPosition
      return { cid: c.contractId, kind: 'Supply', title: `${fmt(+s.shares)} shares`, detail: `${short(s.owner)} · lender` }
    }
    case 'Loan': {
      const l = p as unknown as Loan
      return { cid: c.contractId, kind, title: `${fmt(+l.principal)} USDx`, detail: `${short(l.borrower)} · ${fmtCompact(+l.collateralAmount)} CCx locked` }
    }
    case 'LoanClosed': {
      const l = p as unknown as LoanClosed
      return { cid: c.contractId, kind, title: `${fmt(+l.principal)} USDx`, detail: l.liquidated ? 'liquidated' : 'repaid' }
    }
    case 'AdvanceLine': {
      const l = p as unknown as AdvanceLine
      return { cid: c.contractId, kind: 'AdvLine', title: `limit ${fmt(+l.limit, 0)} USDx`, detail: `for ${short(l.employee)}` }
    }
    case 'Advance': {
      const a = p as unknown as Advance
      return { cid: c.contractId, kind, title: `${fmt(+a.principal)} USDx`, detail: `${short(a.employee)} · wage advance` }
    }
    case 'AdvanceRepaid': {
      const a = p as unknown as AdvanceRepaid
      return { cid: c.contractId, kind: 'AdvRepaid', title: `${fmt(+a.principal + +a.fee)} USDx`, detail: `${short(a.employee)} · ${a.period}` }
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

const ORDER = [
  'Attestation',
  'Payslip',
  'Invoice',
  'InvoiceSettlement',
  'PaidInvoice',
  'DisputedInvoice',
  'PayoutRequest',
  'Loan',
  'Advance',
  'AdvRepaid',
  'LoanClosed',
  'Supply',
  'Market',
  'AdvLine',
  'Pool',
  'SwapReceipt',
  'SwapRequest',
  'LpShare',
  'Preference',
  'Token',
]
const order = (k: string) => ORDER.indexOf(k)

const MAX_COLUMNS = 3

export default function Lens() {
  const { config, persona } = useOrvane()
  const [picked, setPicked] = useState<string[]>(() =>
    persona?.group === 'business' ? ['acme', 'bob', 'auditor'] : ['alice', 'bob', 'carol'],
  )
  if (!config) return null
  const toggle = (key: string) =>
    setPicked((cur) => (cur.includes(key) ? (cur.length > 1 ? cur.filter((k) => k !== key) : cur) : [...cur, key].slice(-MAX_COLUMNS)))
  const columns = config.personas.filter((p) => picked.includes(p.key))
  return (
    <div className="page page-lens">
      <header className="lens-head">
        <p className="eyebrow">Privacy lens · live</p>
        <h1 className="display small">
          One ledger, <em>three truths.</em>
        </h1>
        <p className="lede">
          These are the contracts each participant's node actually holds right now. Make a trade as one persona and watch the other columns:
          they see the pool move, and nothing about you. Run payroll as Acme and compare an employee with the auditor.
        </p>
        <div className="lens-pick" role="group" aria-label="Personas to compare">
          {config.personas.map((p) => (
            <button key={p.key} className={picked.includes(p.key) ? 'on' : ''} aria-pressed={picked.includes(p.key)} onClick={() => toggle(p.key)}>
              <span className={`avatar sm av-${p.key} ${p.group === 'business' ? 'org' : ''}`}>{p.key === 'auditor' ? '§' : p.name[0]}</span>
              {p.name}
            </button>
          ))}
        </div>
      </header>
      <div className="lens-grid">
        {columns.map((p, i) => (
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
        <span className={`avatar av-${persona.key} ${persona.group === 'business' ? 'org' : ''}`}>
          {persona.key === 'auditor' ? '§' : persona.name[0]}
        </span>
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
