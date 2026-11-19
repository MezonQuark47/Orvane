import { VaultStage } from '../three/stage.tsx'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { amountOut } from '../../../shared/amm.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { LedgerError } from '../../../shared/ledger.ts'
import {
  P,
  amountIn,
  disputeInvoice,
  issueInvoice,
  payInvoice,
  payInvoiceConverted,
  runPayroll,
  setPreference,
  withdrawInvoice,
  type DisputedInvoice,
  type Invoice,
  type InvoiceSettlement,
  type PaidInvoice,
  type PayoutPreference,
  type PayrollAttestation,
  type Payslip,
} from '../../../shared/payments.ts'
import { L, payrollWithAdvances, type Advance, type AdvanceLine, type LendingMarket } from '../../../shared/lending.ts'
import { useOrvane, type Config, type Persona } from '../ledger/OrvaneProvider.tsx'
import { AuditorCn, EmployeePayCn, PayrollCnComposer } from './PayrollCn.tsx'
import { InvoicesCnInbox, SupplierDeskCn } from './InvoicesCn.tsx'
import { pick, usePolled } from '../ledger/usePolled.ts'
import { EyeIcon, Panel, Rolling, TokenGlyph, fmt } from '../ui/bits.tsx'

// ---------- data ----------

interface PayData {
  prefs: Contract<PayoutPreference>[]
  payslips: Contract<Payslip>[]
  attestations: Contract<PayrollAttestation>[]
  invoices: Contract<Invoice>[]
  paid: Contract<PaidInvoice>[]
  disputed: Contract<DisputedInvoice>[]
  settling: Contract<InvoiceSettlement>[]
}

const EMPTY: PayData = { prefs: [], payslips: [], attestations: [], invoices: [], paid: [], disputed: [], settling: [] }

function usePayData(): PayData {
  const { ledger, party } = useOrvane()
  const [data, setData] = useState<PayData>(EMPTY)
  useEffect(() => {
    if (!party) return
    setData(EMPTY)
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const all = await ledger.query<unknown>(party, Object.values(P))
        const of = <T,>(name: string) => all.filter((c) => c.templateId.endsWith(`:${name}`)) as Contract<T>[]
        const newest = <T,>(cs: Contract<T>[], key: (t: T) => string) => [...cs].sort((a, b) => key(b.payload).localeCompare(key(a.payload)))
        if (alive)
          setData({
            prefs: of<PayoutPreference>('PayoutPreference'),
            payslips: newest(of<Payslip>('Payslip'), (p) => p.paidAt),
            attestations: newest(of<PayrollAttestation>('PayrollAttestation'), (p) => p.paidAt),
            invoices: of<Invoice>('Invoice'),
            paid: newest(of<PaidInvoice>('PaidInvoice'), (p) => p.paidAt),
            disputed: of<DisputedInvoice>('DisputedInvoice'),
            settling: of<InvoiceSettlement>('InvoiceSettlement'),
          })
      } catch {
        /* keep last */
      }
      if (alive) timer = setTimeout(tick, 1300)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ledger, party])
  return data
}

const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))

const nameOf = (config: Config, party: string) => config.personas.find((p) => p.party === party)?.name ?? party.split('::')[0]

const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000)

// ---------- page ----------

const HEADLINES: Record<string, [string, string, string]> = {
  acme: ['Pay everyone.', 'Show no one.', 'Run payroll and settle supplier invoices with one signature. Each employee sees only their own payslip; your auditor sees the totals.'],
  nova: ['Get paid in', 'your currency.', 'Invoice a customer privately. However they choose to pay, you receive exactly the invoiced amount, in the currency you asked for.'],
  auditor: ['Totals, not', 'salaries.', 'You receive a signed attestation for every payroll run: period, headcount and total. Individual pay never reaches your node.'],
  employee: ['Your pay,', 'your eyes only.', 'Payslips are contracts between you and your employer. Colleagues, the pool and the auditor can’t read them. Choose the currency you want to be paid in.'],
}

export default function Payments() {
  const { persona, config } = useOrvane()
  const data = usePayData()
  if (!persona || !config) return null
  const role = persona.key === 'acme' || persona.key === 'nova' || persona.key === 'auditor' ? persona.key : 'employee'
  const [l1, l2, lede] = HEADLINES[role]

  return (
    <div className="page page-payments">
      <div className="pay-hero">
      <header className="pay-head">
        <p className="eyebrow">Payments · {persona.name}</p>
        <h1 className="display small">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            {l1} <em>{l2}</em>
          </motion.span>
        </h1>
        <p className="lede">{lede}</p>
      </header>
      <VaultStage scene="payments" className="pay-stage" />
      </div>
      {role === 'acme' && <EmployerView data={data} config={config} />}
      {role === 'nova' && (config.exchange ? <SupplierDeskCn /> : <SupplierView data={data} config={config} />)}
      {role === 'auditor' && (config.exchange ? <AuditorCn /> : <AuditorView data={data} />)}
      {role === 'employee' && (config.exchange ? <EmployeePayCn persona={persona} /> : <EmployeeView data={data} config={config} persona={persona} />)}
    </div>
  )
}

// ---------- employer ----------

const DEFAULT_PAY: Record<string, number> = { Alice: 3000, Bob: 2500, Carol: 4200 }
const SLIPPAGE = 0.01

function EmployerView({ data, config }: { data: PayData; config: Config }) {
  return (
    <div className="pay-grid">
      {config.exchange ? <PayrollCnComposer /> : <PayrollComposer data={data} config={config} />}
      <div className="pay-col">
        {config.exchange ? <InvoicesCnInbox /> : <InvoicesInbox data={data} config={config} />}
        {!config.exchange && <PayrollHistory data={data} />}
      </div>
    </div>
  )
}

function PayrollComposer({ data, config }: { data: PayData; config: Config }) {
  const { pool, balances, holdingsFor, submit, party } = useOrvane()
  const employees = config.business.employees
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(employees.map((e) => [e, String(DEFAULT_PAY[nameOf(config, e)] ?? 3000)])),
  )
  const [period, setPeriod] = useState(() => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }))
  const [state, setState] = useState<{ phase: 'idle' | 'busy' | 'done' | 'error'; msg?: string; runId?: string }>({ phase: 'idle' })

  // Open wage advances are repaid out of this payroll, in the same transaction.
  const lend = usePolled([L.Advance, L.AdvanceLine, L.LendingMarket])
  const advances = pick<Advance>(lend, 'Advance').filter((a) => a.payload.employer === party)
  const advLines = pick<AdvanceLine>(lend, 'AdvanceLine')
  const market = pick<LendingMarket>(lend, 'LendingMarket')[0]

  const rows = employees.map((e) => {
    const amount = Number(amounts[e]) || 0
    const deduction = advances.filter((a) => a.payload.employee === e).reduce((s, a) => s + +a.payload.principal + +a.payload.fee, 0)
    const net = Math.max(0, amount - deduction)
    const pref = data.prefs.find((p) => p.payload.employee === e)?.payload.symbol ?? 'USDx'
    const quote = pref === 'CCx' && pool ? amountOut(pool.feeBps, net, pool.reserveA, pool.reserveB) : net
    return { employee: e, name: nameOf(config, e), amount, net, deduction, pref, quote }
  })
  const total = rows.reduce((s, r) => s + r.amount, 0)
  const converting = rows.filter((r) => r.pref !== 'USDx').length
  const short = total > balances.USDx

  const run = async () => {
    const runId = `PR-${Date.now().toString(36).toUpperCase()}`
    setState({ phase: 'busy', runId })
    const common = {
      employer: party!,
      operator: config.operator,
      poolId: config.poolId,
      auditors: [config.business.auditor],
      runId,
      period,
      issuer: config.issuers.USDx,
      symbol: 'USDx',
      holdings: holdingsFor('USDx'),
      lines: rows
        .filter((r) => r.amount > 0)
        .map((r) => ({ employee: r.employee, amount: r.amount, receiveSymbol: r.pref, minReceive: r.pref === 'USDx' ? 0 : r.quote * (1 - SLIPPAGE) })),
    }
    try {
      if (advances.length && market) {
        await submit([
          payrollWithAdvances({
            ...common,
            advances: advances.map((a) => ({
              advanceCid: a.contractId,
              lineCid: advLines.find((l) => l.payload.employee === a.payload.employee)!.contractId,
            })),
            marketCid: market.contractId,
          }),
        ])
      } else {
        await submit([runPayroll(common)])
      }
      setState({ phase: 'done', runId })
    } catch (e) {
      setState({ phase: 'error', msg: errText(e) })
    }
  }

  const slipsForRun = state.runId ? data.payslips.filter((s) => s.payload.runId === state.runId) : []
  const linesInRun = rows.filter((r) => r.net > 0).length

  return (
    <Panel delay={0.1} className="payroll">
      <header className="card-head">
        <h2>Payroll</h2>
        <input className="period mono" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Pay period" />
      </header>
      <div className="pay-table" role="table">
        <div className="pay-row head" role="row">
          <span>Employee</span>
          <span>Gross (USDx)</span>
          <span>Paid as</span>
          <span>They receive</span>
        </div>
        {rows.map((r, i) => (
          <motion.div
            key={r.employee}
            className="pay-row"
            role="row"
            initial={{ opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + i * 0.06 }}
          >
            <span className="emp">
              <span className={`avatar sm av-${r.name.toLowerCase()}`}>{r.name[0]}</span>
              {r.name}
            </span>
            <input
              className="mono cell-input"
              inputMode="decimal"
              value={amounts[r.employee]}
              onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setAmounts({ ...amounts, [r.employee]: e.target.value })}
              aria-label={`Gross pay for ${r.name}`}
            />
            <span className={`pref ${r.pref === 'CCx' ? 'cc' : ''}`}>
              <TokenGlyph symbol={r.pref} size={18} /> {r.pref}
            </span>
            <span className="mono quote">
              {r.pref === 'USDx' ? '' : '≈ '}
              {fmt(r.quote, 2)} {r.pref}
              {r.deduction > 0 && <span className="deduct">−{fmt(r.deduction)} advance repaid</span>}
            </span>
          </motion.div>
        ))}
      </div>
      <div className="pay-total">
        <div>
          <span className="muted small">Total</span>
          <Rolling value={total} className="mono big-ish" /> <span className="muted">USDx</span>
        </div>
        <div className="muted small right">
          Balance {fmt(balances.USDx)} USDx
          <br />
          {converting ? `${converting} line${converting > 1 ? 's' : ''} converted through the pool` : 'No conversions'}
        </div>
      </div>
      <button className={`primary ${state.phase === 'busy' ? 'busy' : ''}`} disabled={short || total <= 0 || state.phase === 'busy'} onClick={run}>
        <span>{short ? 'Not enough USDx' : state.phase === 'busy' ? 'Signing…' : `Run payroll · one signature`}</span>
      </button>
      <AnimatePresence>
        {state.phase === 'done' && (
          <motion.div className="run-status" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0 }}>
            <div className="run-bar">
              <motion.span animate={{ width: `${(slipsForRun.length / linesInRun) * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 18 }} />
            </div>
            <p className="small">
              <span className="mono">{state.runId}</span> · {slipsForRun.length}/{linesInRun} payslips delivered
              {slipsForRun.length < linesInRun ? ' · converting…' : ' · done'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
      {state.phase === 'error' && <p className="tx-error">{state.msg}</p>}
      <p className="whisper small-whisper">
        <EyeIcon /> Each row becomes a separate payslip only its employee can open.
      </p>
    </Panel>
  )
}

function InvoicesInbox({ data, config }: { data: PayData; config: Config }) {
  const { pool, balances, holdingsFor, submit } = useOrvane()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const open = data.invoices

  const act = async (cid: string, cmd: Parameters<typeof submit>[0]) => {
    setBusy(cid)
    setError(undefined)
    try {
      await submit(cmd)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Panel delay={0.2}>
      <header className="card-head">
        <h3>Invoices to pay</h3>
        <span className="muted small">{open.length} open</span>
      </header>
      {open.length === 0 && data.settling.length === 0 && <p className="empty">Nothing due. Nova can issue a new invoice.</p>}
      <ul className="inv-list">
        <AnimatePresence initial={false}>
          {open.map((inv) => {
            const t = inv.payload.terms
            const amt = Number(t.amount)
            const ccNeeded = pool ? amountIn(pool.feeBps, amt, pool.reserveB, pool.reserveA) : Infinity
            const maxIn = ccNeeded * (1 + SLIPPAGE)
            const days = daysUntil(t.dueDate)
            return (
              <motion.li key={inv.contractId} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }}>
                <div className="inv-top">
                  <span className="mono small">{t.invoiceNo}</span>
                  <span className={`due ${days < 10 ? 'soon' : ''}`}>{days >= 0 ? `due in ${days}d` : `${-days}d overdue`}</span>
                </div>
                <div className="inv-mid">
                  <span className="inv-from">{nameOf(config, inv.payload.supplier)}</span>
                  <span className="inv-memo muted">{t.memo}</span>
                </div>
                <div className="inv-amount mono">
                  {fmt(amt)} <span className="muted">{t.symbol}</span>
                </div>
                <div className="inv-actions">
                  <button className="chip-btn" disabled={!!busy || balances.USDx < amt} onClick={() => act(inv.contractId, [payInvoice(inv.contractId, holdingsFor('USDx'))])}>
                    Pay in USDx
                  </button>
                  <button
                    className="chip-btn cc"
                    disabled={!!busy || !Number.isFinite(maxIn) || balances.CCx < maxIn}
                    onClick={() => act(inv.contractId, [payInvoiceConverted(inv.contractId, config.operator, config.poolId, holdingsFor('CCx'), Math.min(maxIn, balances.CCx))])}
                    title="Converted through the pool; Nova still receives USDx"
                  >
                    Pay ≈ {fmt(ccNeeded, 0)} CCx
                  </button>
                  <button className="chip-btn ghosty" disabled={!!busy} onClick={() => act(inv.contractId, [disputeInvoice(inv.contractId, 'Quantities do not match the delivery note')])}>
                    Dispute
                  </button>
                </div>
              </motion.li>
            )
          })}
          {data.settling.map((s) => (
            <motion.li key={s.contractId} layout className="converting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="inv-top">
                <span className="mono small">{s.payload.terms.invoiceNo}</span>
                <span className="due">converting through pool…</span>
              </div>
              <div className="inv-amount mono">
                {fmt(+s.payload.terms.amount)} <span className="muted">{s.payload.terms.symbol}</span>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {error && <p className="tx-error">{error}</p>}
      {data.paid.length > 0 && (
        <>
          <h4 className="sub">Paid</h4>
          <ul className="mini-list">
            {data.paid.slice(0, 4).map((p) => (
              <li key={p.contractId}>
                <span className="mono small">{p.payload.terms.invoiceNo}</span>
                <span className="mono">
                  {fmt(+p.payload.paidAmount)} {p.payload.paidSymbol}
                </span>
                <span className={`tag ${p.payload.converted ? 'tag-SwapReceipt' : ''}`}>{p.payload.converted ? 'converted' : 'direct'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

function PayrollHistory({ data }: { data: PayData }) {
  if (!data.attestations.length) return null
  return (
    <Panel delay={0.3}>
      <header className="card-head">
        <h3>Payroll runs</h3>
        <span className="muted small">attested to your auditor</span>
      </header>
      <ul className="mini-list">
        {data.attestations.slice(0, 5).map((a) => (
          <li key={a.contractId}>
            <span>{a.payload.period}</span>
            <span className="mono">{a.payload.headcount} people</span>
            <span className="mono strong">
              {fmt(+a.payload.total)} {a.payload.symbol}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

// ---------- supplier ----------

function SupplierView({ data, config }: { data: PayData; config: Config }) {
  const { submit, party } = useOrvane()
  const [memo, setMemo] = useState('Pallet racking, 40 units')
  const [raw, setRaw] = useState('4800')
  const [days, setDays] = useState(30)
  const [state, setState] = useState<{ busy?: boolean; error?: string; ok?: string }>({})
  const nextNo = useMemo(() => `NOVA-${1043 + data.invoices.length + data.paid.length + data.disputed.length}`, [data])
  const amount = Number(raw) || 0
  const received = data.paid.reduce((s, p) => s + Number(p.payload.terms.amount), 0)
  const outstanding = data.invoices.reduce((s, p) => s + Number(p.payload.terms.amount), 0)

  const issue = async () => {
    setState({ busy: true })
    try {
      await submit([
        issueInvoice(party!, config.business.employer, {
          invoiceNo: nextNo,
          memo,
          amount,
          issuer: config.issuers.USDx,
          symbol: 'USDx',
          dueDate: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10),
        }),
      ])
      setState({ ok: `${nextNo} sent to Acme` })
    } catch (e) {
      setState({ error: errText(e) })
    }
  }

  return (
    <div className="pay-grid">
      <Panel delay={0.1}>
        <header className="card-head">
          <h2>New invoice</h2>
          <span className="mono small muted">{nextNo}</span>
        </header>
        <div className="form">
          <label>
            <span>Bill to</span>
            <div className="static">
              <span className="avatar sm av-acme">A</span> Acme
            </div>
          </label>
          <label>
            <span>Description</span>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} />
          </label>
          <div className="form-row">
            <label>
              <span>Amount</span>
              <div className="with-unit">
                <input className="mono" inputMode="decimal" value={raw} onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setRaw(e.target.value)} />
                <span>USDx</span>
              </div>
            </label>
            <label>
              <span>Terms</span>
              <div className="seg">
                {[7, 14, 30, 60].map((d) => (
                  <button key={d} className={d === days ? 'on' : ''} onClick={() => setDays(d)}>
                    {d}d
                  </button>
                ))}
              </div>
            </label>
          </div>
        </div>
        <button className="primary" disabled={!amount || !memo || state.busy} onClick={issue}>
          <span>{state.busy ? 'Signing…' : 'Send invoice privately'}</span>
        </button>
        {state.ok && <p className="tx-ok">{state.ok}. Only Acme can see it.</p>}
        {state.error && <p className="tx-error">{state.error}</p>}
      </Panel>
      <div className="pay-col">
        <Panel delay={0.2}>
          <div className="kpis">
            <div>
              <span className="muted small">Outstanding</span>
              <Rolling value={outstanding} className="mono big-ish" />
            </div>
            <div>
              <span className="muted small">Received</span>
              <Rolling value={received} className="mono big-ish ok" />
            </div>
          </div>
          <ul className="mini-list">
            {data.invoices.map((i) => (
              <li key={i.contractId}>
                <span className="mono small">{i.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+i.payload.terms.amount)} USDx</span>
                <button className="link" onClick={() => submit([withdrawInvoice(i.contractId)])}>
                  withdraw
                </button>
              </li>
            ))}
            {data.settling.map((s) => (
              <li key={s.contractId}>
                <span className="mono small">{s.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+s.payload.terms.amount)} USDx</span>
                <span className="tag tag-SwapRequest">converting</span>
              </li>
            ))}
            {data.paid.map((p) => (
              <li key={p.contractId}>
                <span className="mono small">{p.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+p.payload.terms.amount)} USDx</span>
                <span className="tag tag-SwapReceipt">paid{p.payload.converted ? ' · buyer used CCx' : ''}</span>
              </li>
            ))}
            {data.disputed.map((d) => (
              <li key={d.contractId} title={d.payload.reason}>
                <span className="mono small">{d.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+d.payload.terms.amount)} USDx</span>
                <span className="tag warn-tag">disputed</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}

// ---------- auditor ----------

function AuditorView({ data }: { data: PayData }) {
  return (
    <div className="pay-grid single">
      <Panel delay={0.1}>
        <header className="card-head">
          <h2>Payroll attestations</h2>
          <span className="muted small">signed by Acme</span>
        </header>
        {data.attestations.length === 0 ? (
          <p className="empty">No payroll runs yet. Switch to Acme and run one.</p>
        ) : (
          <ul className="attest-list">
            {data.attestations.map((a, i) => (
              <motion.li key={a.contractId} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <div>
                  <span className="serif">{a.payload.period}</span>
                  <span className="mono small muted">{a.payload.runId}</span>
                </div>
                <div className="mono">{a.payload.headcount} employees</div>
                <div className="mono strong">
                  {fmt(+a.payload.total)} {a.payload.symbol}
                </div>
                <div className="redacted" aria-label="Individual salaries are not visible">
                  {Array.from({ length: Number(a.payload.headcount) }, (_, k) => (
                    <span key={k} />
                  ))}
                </div>
              </motion.li>
            ))}
          </ul>
        )}
        <p className="veil">
          <EyeIcon closed /> Names and individual amounts are not on your node. Not hidden by the UI: never sent.
        </p>
      </Panel>
    </div>
  )
}

// ---------- employee ----------

function EmployeeView({ data, config, persona }: { data: PayData; config: Config; persona: Persona }) {
  const { submit } = useOrvane()
  const pref = data.prefs.find((p) => p.payload.employee === persona.party)
  const current = pref?.payload.symbol ?? 'USDx'
  const [busy, setBusy] = useState(false)

  const choose = async (sym: string) => {
    if (sym === current) return
    setBusy(true)
    try {
      await submit([setPreference(persona.party, config.business.employer, sym, pref?.contractId)])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pay-grid">
      <Panel delay={0.1}>
        <header className="card-head">
          <h2>Payslips</h2>
          <span className="muted small">from Acme</span>
        </header>
        {data.payslips.length === 0 ? (
          <p className="empty">No payslips yet. They appear here the moment Acme runs payroll.</p>
        ) : (
          <ul className="slip-list">
            <AnimatePresence initial={false}>
              {data.payslips.map((s) => (
                <motion.li key={s.contractId} layout initial={{ opacity: 0, rotateX: -30, y: -10 }} animate={{ opacity: 1, rotateX: 0, y: 0 }}>
                  <div className="slip-head">
                    <span className="serif">{s.payload.period}</span>
                    <span className="mono small muted">{s.payload.runId}</span>
                  </div>
                  <div className="slip-body">
                    <div>
                      <span className="muted small">Net pay</span>
                      <span className="mono">
                        {fmt(+s.payload.gross)} {s.payload.paySymbol}
                      </span>
                    </div>
                    <div className="arrow">→</div>
                    <div>
                      <span className="muted small">Received</span>
                      <span className="mono strong">
                        {fmt(+s.payload.received)} {s.payload.receivedSymbol}
                      </span>
                    </div>
                  </div>
                  {s.payload.note && <p className="small muted">{s.payload.note}</p>}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </Panel>
      <div className="pay-col">
        <Panel delay={0.2}>
          <header className="card-head">
            <h3>Get paid in</h3>
            <span className="muted small">Acme sees this choice</span>
          </header>
          <div className="pref-toggle">
            {(['USDx', 'CCx'] as const).map((s) => (
              <button key={s} className={current === s ? 'on' : ''} disabled={busy} onClick={() => choose(s)}>
                <TokenGlyph symbol={s} size={30} />
                <span>{s}</span>
                {current === s && <motion.span className="pref-ring" layoutId="pref-ring" />}
              </button>
            ))}
          </div>
          <p className="muted small">
            {current === 'CCx'
              ? 'Acme pays in USDx; the pool converts your line at payout. If the price moves too far, you get USDx instead.'
              : 'Paid directly in USDx, in the same transaction as the rest of payroll.'}
          </p>
        </Panel>
      </div>
    </div>
  )
}
