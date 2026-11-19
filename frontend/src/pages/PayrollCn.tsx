// Payroll on LocalNet: CIP-56 allocations, real Canton Coin conversions.

import { signalSettled } from '../three/settle.ts'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { amountOut } from '../../../shared/amm.ts'
import { Scan, type InstrumentId } from '../../../shared/amulet.ts'
import { createdOf, LedgerError, type Contract } from '../../../shared/ledger.ts'
import { X, allocationSpec, registries, sameInstrument, spendable, type ExchangePool } from '../../../shared/exchange.ts'
import { ALLOCATION_FACTORY_V1, emptyExtraArgs } from '../../../shared/amulet.ts'
import { B, repayAdvanceCn, type AdvanceCn, type AdvanceLineCn } from '../../../shared/billing.ts'
import { CR, type CreditMarket } from '../../../shared/credit.ts'
import {
  TR,
  consentCommand,
  preparePayrollLock,
  preparePayrollRelease,
  type PayeeConsent,
  type PayrollAttestationCn,
  type PayrollBatch,
  type PayslipCn,
} from '../../../shared/treasury.ts'
import { useOrvane, type Config, type Persona } from '../ledger/OrvaneProvider.tsx'
import { pick, usePolled } from '../ledger/usePolled.ts'
import { EyeIcon, Panel, Rolling, TokenGlyph, fmt } from '../ui/bits.tsx'

const TEMPLATES = [TR.PayeeConsent, TR.PayslipCn, TR.PayrollAttestationCn, TR.PayrollBatch, X.ExchangePool, B.AdvanceCn, B.AdvanceLineCn, CR.CreditMarket] as const
const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)
const glyph = (i: InstrumentId) => (i.id === 'USDx' ? 'USDx' : 'CCx')
const DEFAULT_PAY: Record<string, number> = { Alice: 3000, Bob: 2500, Carol: 4200 }
const exerciseResultOf = (tx: { events: unknown[] }, choice: string) =>
  (tx.events as Array<Record<string, { choice?: string; exerciseResult?: unknown }>>).find((e) => e.ExercisedEvent?.choice === choice)?.ExercisedEvent?.exerciseResult
const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))
const nameOf = (config: Config, party: string) => config.personas.find((p) => p.party === party)?.name ?? party.split('::')[0]

function useCnData() {
  const rows = usePolled(TEMPLATES, 1300)
  return {
    consents: pick<PayeeConsent>(rows, 'PayeeConsent'),
    payslips: pick<PayslipCn>(rows, 'PayslipCn').sort((a, b) => b.payload.runId.localeCompare(a.payload.runId)),
    attestations: pick<PayrollAttestationCn>(rows, 'PayrollAttestationCn').sort((a, b) => b.payload.runId.localeCompare(a.payload.runId)),
    batches: pick<PayrollBatch>(rows, 'PayrollBatch'),
    pool: pick<ExchangePool>(rows, 'ExchangePool')[0],
    advances: pick<AdvanceCn>(rows, 'AdvanceCn'),
    lines: pick<AdvanceLineCn>(rows, 'AdvanceLineCn'),
    market: pick<CreditMarket>(rows, 'CreditMarket')[0],
  }
}

// ---------- employer ----------

type Step = 'idle' | 'locking' | 'locked' | 'releasing' | 'done' | 'error'

export function PayrollCnComposer() {
  const { config, ledger, party } = useOrvane()
  const cfg = config!
  const ex = cfg.exchange!
  const data = useCnData()
  const employees = cfg.business.employees
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(employees.map((e) => [e, String(DEFAULT_PAY[nameOf(cfg, e)] ?? 3000)])),
  )
  const [period, setPeriod] = useState(() => new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }))
  const [step, setStep] = useState<{ s: Step; msg?: string; runId?: string }>({ s: 'idle' })

  const pool = data.pool?.payload
  const rows = employees.map((e) => {
    const gross = Number(amounts[e]) || 0
    // open wage advances are repaid on payday, out of this pay
    const advances = data.advances.filter((a) => a.payload.employee === e && a.payload.employer === party)
    const deduction = advances.reduce((s, a) => s + +a.payload.principal + +a.payload.fee, 0)
    const amount = Math.max(0, Math.round((gross - deduction) * 1e6) / 1e6)
    const consent = data.consents.find((c) => c.payload.employee === e)
    const receive = consent?.payload.receive ?? ex.usdx
    const wantsCC = sameInstrument(receive, ex.amulet)
    let quote = amount
    if (wantsCC && pool) {
      const inIsA = sameInstrument(ex.usdx, pool.instrA)
      const [ri, ro] = inIsA ? [+pool.reserveA, +pool.reserveB] : [+pool.reserveB, +pool.reserveA]
      quote = amountOut(+pool.feeBps, amount, ri, ro)
    }
    return { employee: e, name: nameOf(cfg, e), gross, amount, deduction, advances, consent, receive, wantsCC, quote }
  })
  const total = rows.reduce((s, r) => s + r.gross, 0)
  const missing = rows.filter((r) => r.amount > 0 && !r.consent)

  const run = async () => {
    if (!party) return
    const runId = `PR-${Date.now().toString(36).toUpperCase()}`
    setStep({ s: 'locking', runId })
    try {
      const reg = registries(ledger, new Scan(''), ex.realAmulet ? ex.amulet.admin : '')
      const usdxReg = reg.forInstrument(ex.usdx, party)
      // 1. lock each advance repayment (employer -> operator, executed by the employer on payday)
      const repayments: Array<{ advanceCid: string; employee: string; allocationCid: string }> = []
      for (const r of rows) {
        for (const a of r.advances) {
          const holdings = await spendable(ledger, party, ex.usdx)
          const owed = +a.payload.principal + +a.payload.fee
          const allocation = allocationSpec({ executor: party, ref: runId, sender: party, receiver: cfg.operator, instrument: ex.usdx, amount: owed, legId: `adv-${r.name}` })
          const requestedAt = new Date(Date.now() - 5_000).toISOString()
          const inputHoldingCids = holdings.map((h) => h.contractId)
          const f = await usdxReg.allocationFactory({ expectedAdmin: ex.usdx.admin, allocation, requestedAt, inputHoldingCids, extraArgs: emptyExtraArgs })
          const atx = await ledger.submit(
            [party],
            [
              {
                ExerciseCommand: {
                  templateId: ALLOCATION_FACTORY_V1,
                  contractId: f.factoryId,
                  choice: 'AllocationFactory_Allocate',
                  choiceArgument: { expectedAdmin: ex.usdx.admin, allocation, requestedAt, inputHoldingCids, extraArgs: f.extraArgs },
                },
              },
            ],
            [],
            f.disclosed,
          )
          const res = exerciseResultOf(atx, 'AllocationFactory_Allocate') as { output: { value: { allocationCid: string } } }
          repayments.push({ advanceCid: a.contractId, employee: r.employee, allocationCid: res.output.value.allocationCid })
        }
      }
      // 2. lock the (net) payroll lines
      const treasury = await spendable(ledger, party, ex.usdx)
      const lines = rows.filter((r) => r.amount > 0).map((r) => ({ employee: r.employee, amount: r.amount }))
      const lock = await preparePayrollLock({
        reg,
        employer: party,
        auditors: [cfg.business.auditor],
        runId,
        period,
        instrument: ex.usdx,
        inputHoldingCids: treasury.map((h) => h.contractId),
        lines,
      })
      const tx = await ledger.submit([party], [lock.command], [], lock.disclosed)
      const created = createdOf(tx, TR.PayrollBatch)
      if (!created) throw new Error('payroll batch was not created')
      setStep({ s: 'locked', runId })
      await new Promise((r) => setTimeout(r, 900)) // let the user see the locked state
      setStep({ s: 'releasing', runId })
      const release = await preparePayrollRelease({
        reg,
        employer: party,
        batchCid: created.contractId,
        batch: created.createArgument as PayrollBatch,
        consents: new Map(rows.filter((r) => r.consent).map((r) => [r.employee, r.consent!.contractId])),
      })
      // 3. payday: release payroll and repay advances in ONE transaction
      const repayCtx = await Promise.all(repayments.map((x) => usdxReg.allocationArgs(x.allocationCid, 'execute-transfer')))
      const repayCmds = repayments.map((x, i) =>
        repayAdvanceCn(x.advanceCid, {
          allocationCid: x.allocationCid,
          marketCid: data.market!.contractId,
          lineCid: data.lines.find((l) => l.payload.employee === x.employee)!.contractId,
          extraArgs: repayCtx[i].extraArgs,
          period,
        }),
      )
      await ledger.submit([party], [release.command, ...repayCmds], [], [...release.disclosed, ...repayCtx.flatMap((c) => c.disclosed)])
      setStep({ s: 'done', runId })
      signalSettled('USDx')
    } catch (e) {
      setStep({ s: 'error', msg: errText(e) })
    }
  }

  const busy = step.s === 'locking' || step.s === 'locked' || step.s === 'releasing'
  const stages = ['Lines locked as allocations', 'Released atomically', 'Payslips delivered']
  const reached = step.s === 'locking' ? 0 : step.s === 'locked' || step.s === 'releasing' ? 1 : step.s === 'done' ? 3 : -1

  return (
    <Panel delay={0.1} className="payroll">
      <header className="card-head">
        <h2>Payroll</h2>
        <input className="period mono" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Pay period" />
      </header>
      <p className="muted small cip">
        <span className="badge">CIP-56</span> Paid in Orvane USDx through token-standard allocations. CC lines convert through the{' '}
        {ex.realAmulet ? 'real Canton Coin pool' : 'USDx / CC pool'}. Open wage advances are repaid in the same payday transaction.
      </p>
      <div className="pay-table" role="table">
        <div className="pay-row head" role="row">
          <span>Employee</span>
          <span>Gross (USDx)</span>
          <span>Receives</span>
          <span>≈ Amount</span>
        </div>
        {rows.map((r, i) => (
          <motion.div key={r.employee} className="pay-row" role="row" initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.06 }}>
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
            <span className={`pref ${r.wantsCC ? 'cc' : ''}`}>
              <TokenGlyph symbol={glyph(r.receive)} size={18} /> {r.consent ? label(r.receive) : 'no consent'}
            </span>
            <span className="mono quote">
              {r.wantsCC ? '≈ ' : ''}
              {fmt(r.quote, r.wantsCC ? 0 : 2)} {label(r.receive)}
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
        <div className="muted small right">{missing.length ? `${missing.length} employee(s) haven't given consent` : 'All employees consented'}</div>
      </div>
      <button className={`primary ${busy ? 'busy' : ''}`} disabled={busy || total <= 0 || missing.length > 0} onClick={run}>
        <span>{busy ? (step.s === 'locking' ? 'Locking funds…' : 'Releasing payroll…') : 'Lock & release payroll'}</span>
      </button>
      {step.s !== 'idle' && (
        <motion.div className="timeline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
          {step.s === 'error' ? (
            <p className="tx-error">{step.msg}</p>
          ) : (
            <ol className="three">
              {stages.map((s, i) => (
                <li key={s} className={i < reached ? 'done' : i === reached ? 'active' : ''}>
                  <span className="dot" />
                  {s}
                </li>
              ))}
            </ol>
          )}
          {step.s === 'done' && <p className="tx-ok">Run {step.runId}: everyone paid in one transaction.</p>}
        </motion.div>
      )}
      <p className="whisper small-whisper">
        <EyeIcon /> Each employee sees only their own allocation and payslip. The operator sees only conversions.
      </p>
      {data.attestations.length > 0 && (
        <>
          <h4 className="sub">Runs attested to your auditor</h4>
          <ul className="mini-list">
            {data.attestations.slice(0, 4).map((a) => (
              <li key={a.contractId}>
                <span>{a.payload.period}</span>
                <span className="mono">{a.payload.headcount} people</span>
                <span className="mono strong">{fmt(+a.payload.total)} USDx</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}

// ---------- employee ----------

export function EmployeePayCn({ persona }: { persona: Persona }) {
  const { config, ledger } = useOrvane()
  const ex = config!.exchange!
  const data = useCnData()
  const consent = data.consents.find((c) => c.payload.employee === persona.party)
  const current = consent ? (sameInstrument(consent.payload.receive, ex.amulet) ? 'CC' : 'USDx') : undefined
  const [busy, setBusy] = useState(false)

  const choose = async (sym: 'USDx' | 'CC') => {
    if (sym === current) return
    setBusy(true)
    try {
      await ledger.submit([persona.party], [
        consentCommand(persona.party, config!.business.employer, config!.operator, sym === 'CC' ? ex.amulet : ex.usdx, consent?.contractId),
      ])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pay-grid">
      <Panel delay={0.1}>
        <header className="card-head">
          <h2>Payslips</h2>
          <span className="muted small">signed by Acme and you</span>
        </header>
        {data.payslips.length === 0 ? (
          <p className="empty">No payslips yet. They appear the moment Acme releases payroll.</p>
        ) : (
          <ul className="slip-list">
            <AnimatePresence initial={false}>
              {data.payslips.map((s: Contract<PayslipCn>) => (
                <motion.li key={s.contractId} layout initial={{ opacity: 0, rotateX: -30, y: -10 }} animate={{ opacity: 1, rotateX: 0, y: 0 }}>
                  <div className="slip-head">
                    <span className="serif">{s.payload.period}</span>
                    <span className="mono small muted">{s.payload.runId}</span>
                  </div>
                  <div className="slip-body">
                    <div>
                      <span className="muted small">Paid</span>
                      <span className="mono strong">
                        {fmt(+s.payload.paid)} {label(s.payload.instrument)}
                      </span>
                    </div>
                    <div className="arrow">{s.payload.convertTo ? '→' : ''}</div>
                    <div>
                      {s.payload.convertTo && (
                        <>
                          <span className="muted small">Converting to</span>
                          <span className="mono">{label(s.payload.convertTo)} via the pool</span>
                        </>
                      )}
                    </div>
                  </div>
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
            <span className="muted small">your signed consent</span>
          </header>
          <div className="pref-toggle">
            {(['USDx', 'CC'] as const).map((s) => (
              <button key={s} className={current === s ? 'on' : ''} disabled={busy} onClick={() => choose(s)}>
                <TokenGlyph symbol={s === 'CC' ? 'CCx' : 'USDx'} size={30} />
                <span>{s === 'CC' ? 'Canton Coin' : 'USDx'}</span>
                {current === s && <motion.span className="pref-ring" layoutId="pref-ring-cn" />}
              </button>
            ))}
          </div>
          <p className="muted small">
            {current === 'CC'
              ? 'Acme pays in USDx; your pay is converted into real Canton Coin through the Orvane pool, using the authority you granted in this consent.'
              : current
                ? 'Paid directly in USDx through a token-standard allocation.'
                : 'You have not consented yet. Choose a currency to sign your consent.'}
          </p>
        </Panel>
      </div>
    </div>
  )
}

// ---------- auditor ----------

export function AuditorCn() {
  const data = useCnData()
  return (
    <div className="pay-grid single">
      <Panel delay={0.1}>
        <header className="card-head">
          <h2>Payroll attestations</h2>
          <span className="muted small">CIP-56 runs · signed by Acme</span>
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
                <div className="mono strong">{fmt(+a.payload.total)} USDx</div>
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
