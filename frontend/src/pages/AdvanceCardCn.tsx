// Earned-wage advance on the token standard, for an employee with a line.

import { useState } from 'react'
import { type Contract } from '../../../shared/ledger.ts'
import { requestAdvanceCn, type AdvanceCn, type AdvanceLineCn } from '../../../shared/billing.ts'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { Panel, fmt } from '../ui/bits.tsx'
import { useActivity } from '../ui/activity.tsx'
import { errorText } from '../ui/errors.ts'

export default function AdvanceCardCn({ line, open, pending }: { line: Contract<AdvanceLineCn>; open?: Contract<AdvanceCn>; pending: boolean }) {
  const { config, ledger, party } = useOrvane()
  const l = line.payload
  const limit = +l.limit
  const [amount, setAmount] = useState(Math.floor(limit * 0.6))
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({})
  const fee = (amount * +l.feeBps) / 10_000
  const activity = useActivity()

  const go = async () => {
    setState({ busy: true })
    try {
      await activity.track(
        `Wage advance ${fmt(amount)} USDx`,
        () => ledger.submit([party!], [requestAdvanceCn(party!, config!.operator, line.contractId, amount)]),
        { detail: `Fee ${fmt(fee)} USDx, repaid from your next payslip`, done: () => ({ detail: `Requested. Repaid automatically on payday, fee ${fmt(fee)} USDx.` }) },
      )
      setState({})
    } catch (e) {
      setState({ error: errorText(e) })
    }
  }

  return (
    <Panel delay={0.12} className="advance-card">
      <header className="card-head">
        <h2>Get paid early</h2>
        <span className="badge">CIP-56 · backed by Acme</span>
      </header>
      {open ? (
        <div className="advance-open">
          <div>
            <span className="muted small">Advance received</span>
            <span className="mono big-ish ok">{fmt(+open.payload.principal)} USDx</span>
          </div>
          <p className="muted small">
            {fmt(+open.payload.principal + +open.payload.fee)} USDx (incl. {fmt(+open.payload.fee)} fee) is repaid by Acme on payday, in the same
            transaction that releases payroll. Colleagues and lenders can&apos;t see this.
          </p>
        </div>
      ) : (
        <>
          <div className="advance-limit">
            <span className="muted small">Available</span>
            <span className="mono big-ish">{fmt(limit - +l.drawn)}</span>
            <span className="muted small">USDx of {fmt(limit)}</span>
          </div>
          <input
            type="range"
            className="slider"
            min={0}
            max={limit}
            step={10}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            aria-label="Advance amount"
            style={{ '--fill': `${(amount / limit) * 100}%` } as React.CSSProperties}
          />
          <dl className="details tight">
            <div>
              <dt>You get now</dt>
              <dd className="mono strong">{fmt(amount)} USDx</dd>
            </div>
            <div>
              <dt>Deducted next payroll</dt>
              <dd className="mono">
                {fmt(amount + fee)} USDx ({fmt(+l.feeBps / 100, 0)}% fee)
              </dd>
            </div>
          </dl>
          <button className={`primary ${state.busy || pending ? 'busy' : ''}`} disabled={state.busy || pending || amount <= 0} onClick={go}>
            <span>{state.busy || pending ? 'Settling…' : `Get ${fmt(amount, 0)} USDx now`}</span>
          </button>
        </>
      )}
      {state.error && <p className="tx-error">{state.error}</p>}
    </Panel>
  )
}
