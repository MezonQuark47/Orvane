// Token-standard invoices: buyer inbox (Acme) and supplier desk (Nova).

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Scan, type InstrumentId } from '../../../shared/amulet.ts'
import { LedgerError, type Contract } from '../../../shared/ledger.ts'
import { X, allocationSpec, registries, sameInstrument, spendable, type ExchangePool } from '../../../shared/exchange.ts'
import { emptyExtraArgs } from '../../../shared/amulet.ts'
import {
  B,
  disputeInvoiceCn,
  issueInvoiceCn,
  lockInvoice,
  payInvoiceConverted,
  reissueInvoiceCn,
  settleInvoicePayment,
  withdrawInvoiceCn,
  type DisputedInvoiceCn,
  type InvoiceCn,
  type InvoiceConversionCn,
  type PaidInvoiceCn,
} from '../../../shared/billing.ts'
import { createdOf } from '../../../shared/ledger.ts'
import { newRef, prepareAllocationArgs } from '../../../shared/credit.ts'
import { amountIn } from '../../../shared/payments.ts'
import { useOrvane, type Config } from '../ledger/OrvaneProvider.tsx'
import { pick, usePolled } from '../ledger/usePolled.ts'
import { Panel, Rolling, fmt } from '../ui/bits.tsx'

const TEMPLATES = [B.InvoiceCn, B.PaidInvoiceCn, B.DisputedInvoiceCn, B.InvoiceConversionCn, B.InvoicePaymentCn, X.ExchangePool] as const
const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))
const nameOf = (config: Config, party: string) => config.personas.find((p) => p.party === party)?.name ?? party.split('::')[0]
const daysUntil = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 86_400_000)
const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)
const BUFFER = 1.003 // slippage buffer for converted payments; any excess stays in the pool

function useInvoices() {
  const rows = usePolled(TEMPLATES, 1300)
  return {
    open: pick<InvoiceCn>(rows, 'InvoiceCn'),
    paid: pick<PaidInvoiceCn>(rows, 'PaidInvoiceCn').sort((a, b) => b.payload.paidAt.localeCompare(a.payload.paidAt)),
    disputed: pick<DisputedInvoiceCn>(rows, 'DisputedInvoiceCn'),
    converting: pick<InvoiceConversionCn>(rows, 'InvoiceConversionCn'),
    locked: pick(rows, 'InvoicePaymentCn'),
    pool: pick<ExchangePool>(rows, 'ExchangePool')[0]?.payload,
  }
}

// ---------- buyer ----------

export function InvoicesCnInbox() {
  const { config, ledger, party } = useOrvane()
  const cfg = config!
  const ex = cfg.exchange!
  const data = useInvoices()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const reg = () => registries(ledger, new Scan(''), ex.realAmulet ? ex.amulet.admin : '')

  const ccNeeded = (amount: number) => {
    const p = data.pool
    if (!p) return Infinity
    const ccIsA = sameInstrument(p.instrA, ex.amulet)
    const [resIn, resOut] = ccIsA ? [+p.reserveA, +p.reserveB] : [+p.reserveB, +p.reserveA]
    return amountIn(+p.feeBps, amount, resIn, resOut)
  }

  const act = async (cid: string, fn: () => Promise<void>) => {
    setBusy(cid)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(undefined)
    }
  }

  // Same currency: lock to the supplier, then settle. Two submissions, one click.
  const payDirect = (inv: Contract<InvoiceCn>) =>
    act(inv.contractId, async () => {
      const t = inv.payload.terms
      const r = reg()
      const holdings = await spendable(ledger, party!, t.instrument)
      const allocation = allocationSpec({ executor: party!, ref: newRef('inv'), sender: party!, receiver: inv.payload.supplier, instrument: t.instrument, amount: +t.amount, legId: 'pay' })
      const requestedAt = new Date(Date.now() - 5_000).toISOString()
      const inputHoldingCids = holdings.map((h) => h.contractId)
      const f = await r.forInstrument(t.instrument, party!).allocationFactory({ expectedAdmin: t.instrument.admin, allocation, requestedAt, inputHoldingCids, extraArgs: emptyExtraArgs })
      const tx = await ledger.submit([party!], [lockInvoice(inv.contractId, { factoryCid: f.factoryId, allocation, requestedAt, inputHoldingCids, extraArgs: f.extraArgs })], [], f.disclosed)
      const payment = createdOf(tx, B.InvoicePaymentCn)
      if (!payment) throw new Error('payment was not locked')
      const allocationCid = (payment.createArgument as { allocationCid: string }).allocationCid
      const ctx = await r.forInstrument(t.instrument, party!).allocationArgs(allocationCid, 'execute-transfer')
      await ledger.submit([party!], [settleInvoicePayment(payment.contractId, ctx.extraArgs)], [], ctx.disclosed)
    })

  const payWithCC = (inv: Contract<InvoiceCn>) =>
    act(inv.contractId, async () => {
      const need = ccNeeded(+inv.payload.terms.amount) * BUFFER
      const prep = await prepareAllocationArgs({ ledger, reg: reg(), sender: party!, operator: cfg.operator, instrument: ex.amulet, amount: Math.ceil(need * 1e4) / 1e4, ref: newRef('inv-cc') })
      await ledger.submit([party!], [payInvoiceConverted(inv.contractId, cfg.operator, ex.poolId, prep.fields)], [], prep.disclosed)
    })

  return (
    <Panel delay={0.2}>
      <header className="card-head">
        <h3>Invoices to pay</h3>
        <span className="badge">CIP-56</span>
      </header>
      {data.open.length === 0 && data.converting.length === 0 && <p className="empty">Nothing due. Nova can issue a new invoice.</p>}
      <ul className="inv-list">
        <AnimatePresence initial={false}>
          {data.open.map((inv) => {
            const t = inv.payload.terms
            const amt = +t.amount
            const cc = ccNeeded(amt) * BUFFER
            const days = daysUntil(t.dueDate)
            return (
              <motion.li key={inv.contractId} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }}>
                <div className="inv-top">
                  <span className="mono small">{t.invoiceNo}</span>
                  <span className={`due ${days < 10 ? 'soon' : ''}`}>{days >= 0 ? `due in ${days}d` : `${-days}d overdue`}</span>
                </div>
                <div className="inv-mid">
                  <span className="inv-from">{nameOf(cfg, inv.payload.supplier)}</span>
                  <span className="inv-memo muted">{t.memo}</span>
                </div>
                <div className="inv-amount mono">
                  {fmt(amt)} <span className="muted">{label(t.instrument)}</span>
                </div>
                <div className="inv-actions">
                  <button className="chip-btn" disabled={!!busy} onClick={() => payDirect(inv)}>
                    {busy === inv.contractId ? 'Paying…' : `Pay in ${label(t.instrument)}`}
                  </button>
                  <button className="chip-btn cc" disabled={!!busy || !Number.isFinite(cc)} onClick={() => payWithCC(inv)} title="Converted through the pool; the supplier still receives USDx">
                    Pay ≈ {fmt(cc, 0)} CC
                  </button>
                  <button className="chip-btn ghosty" disabled={!!busy} onClick={() => act(inv.contractId, () => ledger.submit([party!], [disputeInvoiceCn(inv.contractId, 'Quantities do not match the delivery note')]).then(() => undefined))}>
                    Dispute
                  </button>
                </div>
              </motion.li>
            )
          })}
          {data.converting.map((c) => (
            <motion.li key={c.contractId} layout className="converting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="inv-top">
                <span className="mono small">{c.payload.terms.invoiceNo}</span>
                <span className="due">converting through the pool…</span>
              </div>
              <div className="inv-amount mono">
                {fmt(+c.payload.terms.amount)} <span className="muted">USDx</span>
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
                  {fmt(+p.payload.paidAmount)} {label(p.payload.paidInstrument)}
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

// ---------- supplier ----------

export function SupplierDeskCn() {
  const { config, ledger, party } = useOrvane()
  const cfg = config!
  const ex = cfg.exchange!
  const data = useInvoices()
  const [memo, setMemo] = useState('Pallet racking, 40 units')
  const [raw, setRaw] = useState('4800')
  const [days, setDays] = useState(30)
  const [state, setState] = useState<{ busy?: boolean; error?: string; ok?: string }>({})
  const nextNo = `NOVA-${2043 + data.open.length + data.paid.length + data.disputed.length + data.converting.length}`
  const amount = Number(raw) || 0
  const received = data.paid.reduce((s, p) => s + +p.payload.terms.amount, 0)
  const outstanding = data.open.reduce((s, p) => s + +p.payload.terms.amount, 0)

  const issue = async () => {
    setState({ busy: true })
    try {
      await ledger.submit([party!], [
        issueInvoiceCn(party!, cfg.business.employer, { invoiceNo: nextNo, memo, amount, instrument: ex.usdx, dueDate: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) }),
      ])
      setState({ ok: `${nextNo} sent to Acme. Only Acme can see it.` })
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
              <span className="avatar sm av-acme org">A</span> Acme
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
        {state.ok && <p className="tx-ok">{state.ok}</p>}
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
            {data.open.map((i) => (
              <li key={i.contractId}>
                <span className="mono small">{i.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+i.payload.terms.amount)} USDx</span>
                <button className="link" onClick={() => ledger.submit([party!], [withdrawInvoiceCn(i.contractId)])}>
                  withdraw
                </button>
              </li>
            ))}
            {data.converting.map((c) => (
              <li key={c.contractId}>
                <span className="mono small">{c.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+c.payload.terms.amount)} USDx</span>
                <span className="tag tag-SwapRequest">converting</span>
              </li>
            ))}
            {data.paid.map((p) => (
              <li key={p.contractId}>
                <span className="mono small">{p.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+p.payload.terms.amount)} USDx</span>
                <span className="tag tag-SwapReceipt">paid{p.payload.converted ? ' · buyer used CC' : ''}</span>
              </li>
            ))}
            {data.disputed.map((d) => (
              <li key={d.contractId} title={d.payload.reason}>
                <span className="mono small">{d.payload.terms.invoiceNo}</span>
                <span className="mono">{fmt(+d.payload.terms.amount)} USDx</span>
                <button
                  className="link"
                  onClick={() =>
                    ledger.submit([party!], [
                      reissueInvoiceCn(d.contractId, { ...d.payload.terms, invoiceNo: `${d.payload.terms.invoiceNo}-R1`, amount: (Math.round(+d.payload.terms.amount * 0.9 * 100) / 100).toFixed(10) }),
                    ])
                  }
                >
                  reissue −10%
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  )
}
