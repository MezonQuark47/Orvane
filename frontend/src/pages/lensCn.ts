// What the privacy lens shows on the token-standard flows: every Orvane
// contract a party's node holds, plus its CIP-56 holdings read through the
// standard Holding interface.

import { HOLDING_V1, type HoldingView, type InstrumentId } from '../../../shared/amulet.ts'
import type { Contract, JsonLedger } from '../../../shared/ledger.ts'
import { X, type ExchangePool, type ExchangeReceipt, type ExchangeSwapRequest } from '../../../shared/exchange.ts'
import { LQ, type LpDepositRequest, type LpShare } from '../../../shared/liquidity.ts'
import { TR, type ConvertTicket, type PayeeConsent, type PayrollAttestationCn, type PayrollBatch, type PayslipCn } from '../../../shared/treasury.ts'
import { B, type AdvanceCn, type AdvanceLineCn, type AdvanceRequestCn, type InvoiceCn } from '../../../shared/billing.ts'
import { CR, type CreditLoan, type CreditLoanClosed, type CreditMarket, type CreditPosition } from '../../../shared/credit.ts'
import { fmt, fmtCompact } from '../ui/bits.tsx'

export type Row = { cid: string; kind: string; title: string; detail: string }

const CN_TEMPLATES = [
  X.ExchangePool,
  X.ExchangeReceipt,
  X.ExchangeSwapRequest,
  LQ.LpShare,
  LQ.LpDepositRequest,
  LQ.LpWithdrawRequest,
  TR.PayeeConsent,
  TR.PayslipCn,
  TR.PayrollAttestationCn,
  TR.PayrollBatch,
  TR.ConvertTicket,
  B.InvoiceCn,
  B.InvoicePaymentCn,
  B.InvoiceConversionCn,
  B.PaidInvoiceCn,
  B.DisputedInvoiceCn,
  B.AdvanceLineCn,
  B.AdvanceRequestCn,
  B.AdvanceCn,
  B.AdvanceRepaidCn,
  CR.CreditMarket,
  CR.CreditPosition,
  CR.CreditLoan,
  CR.CreditLoanClosed,
  CR.CreditBorrowRequest,
  CR.CreditRepayRequest,
  CR.CreditSupplyRequest,
  CR.CreditWithdrawRequest,
]

const short = (party: string) => party.split('::')[0]
const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)

function describe(c: Contract<unknown>, self: string): Row {
  const kind = c.templateId.split(':').pop()!
  const p = c.payload as Record<string, unknown>
  const row = (k: string, title: string, detail: string): Row => ({ cid: c.contractId, kind: k, title, detail })
  switch (kind) {
    case 'ExchangePool': {
      const x = p as unknown as ExchangePool
      return row('Pool', `Pool ${x.poolId}`, `${fmtCompact(+x.reserveA)} ${label(x.instrA)} · ${fmtCompact(+x.reserveB)} ${label(x.instrB)}`)
    }
    case 'ExchangeReceipt': {
      const r = p as unknown as ExchangeReceipt
      return row('Receipt', `${fmt(+r.amountIn)} ${label(r.instrumentIn)} → ${fmt(+r.amountOut, 2)} ${label(r.instrumentOut)}`, 'trade receipt')
    }
    case 'ExchangeSwapRequest': {
      const r = p as unknown as ExchangeSwapRequest
      return row('SwapRequest', `${fmt(+r.amountIn)} ${label(r.inputInstrument)}`, 'swap awaiting settlement')
    }
    case 'LpShare': {
      const s = p as unknown as LpShare
      return row('LpShare', `${fmt(+s.shares)} LP shares`, s.owner === self ? s.poolId : `held by ${short(s.owner)}`)
    }
    case 'LpDepositRequest': {
      const r = p as unknown as LpDepositRequest
      return row('LpDeposit', `${fmt(+r.amountA)} ${label(r.instrumentA)} + ${fmt(+r.amountB, 0)} ${label(r.instrumentB)}`, 'deposit awaiting settlement')
    }
    case 'LpWithdrawRequest':
      return row('LpWithdraw', 'LP withdrawal', 'awaiting settlement')
    case 'PayeeConsent': {
      const x = p as unknown as PayeeConsent
      return row('Preference', `${short(x.employee)} → ${label(x.receive)}`, 'payout currency')
    }
    case 'PayslipCn': {
      const s = p as unknown as PayslipCn
      return row('Payslip', `${fmt(+s.paid)} ${label(s.instrument)}`, `${short(s.employee)} · ${s.period}${s.convertTo ? ` · paid in ${label(s.convertTo)}` : ''}`)
    }
    case 'PayrollAttestationCn': {
      const a = p as unknown as PayrollAttestationCn
      return row('Attestation', `${fmt(+a.total)} ${label(a.instrument)} · ${a.headcount} people`, a.period)
    }
    case 'PayrollBatch': {
      const b = p as unknown as PayrollBatch
      return row('Batch', `${b.locked.length} pay lines locked`, b.period)
    }
    case 'ConvertTicket': {
      const t = p as unknown as ConvertTicket
      return row('Conversion', `${fmt(+t.amount)} ${label(t.from)} → ${label(t.to)}`, `for ${short(t.employee)}`)
    }
    case 'InvoiceCn':
    case 'InvoicePaymentCn':
    case 'InvoiceConversionCn':
    case 'PaidInvoiceCn':
    case 'DisputedInvoiceCn': {
      const inv = p as unknown as InvoiceCn
      const [k, state] = {
        InvoiceCn: ['Invoice', 'open'],
        InvoicePaymentCn: ['Invoice', 'locked'],
        InvoiceConversionCn: ['InvoiceSettlement', 'converting'],
        PaidInvoiceCn: ['PaidInvoice', 'paid'],
        DisputedInvoiceCn: ['DisputedInvoice', 'disputed'],
      }[kind]!
      return row(k, `${inv.terms.invoiceNo} · ${fmt(+inv.terms.amount)} ${label(inv.terms.instrument)}`, `${short(inv.supplier)} → ${short(inv.buyer)} · ${state}`)
    }
    case 'AdvanceLineCn': {
      const l = p as unknown as AdvanceLineCn
      return row('AdvLine', `limit ${fmt(+l.limit, 0)} USDx`, `for ${short(l.employee)}`)
    }
    case 'AdvanceRequestCn': {
      const r = p as unknown as AdvanceRequestCn
      return row('AdvRequest', `${fmt(+r.amount)} USDx`, `${short(r.employee)} · requested`)
    }
    case 'AdvanceCn': {
      const a = p as unknown as AdvanceCn
      return row('Advance', `${fmt(+a.principal)} USDx`, `${short(a.employee)} · wage advance`)
    }
    case 'AdvanceRepaidCn': {
      const a = p as unknown as { employee: string; principal: string; fee: string; period: string }
      return row('AdvRepaid', `${fmt(+a.principal + +a.fee)} USDx`, `${short(a.employee)} · ${a.period}`)
    }
    case 'CreditMarket': {
      const m = p as unknown as CreditMarket
      return row('Market', `${fmtCompact(+m.cash + +m.principalOut)} supplied`, `${fmtCompact(+m.principalOut)} borrowed · totals only`)
    }
    case 'CreditPosition': {
      const s = p as unknown as CreditPosition
      return row('Supply', `${fmt(+s.shares)} shares`, `${short(s.owner)} · lender`)
    }
    case 'CreditLoan': {
      const l = p as unknown as CreditLoan
      return row('Loan', `${fmt(+l.principal)} USDx`, `${short(l.borrower)} · ${fmtCompact(+l.collateralAmount)} CC locked`)
    }
    case 'CreditLoanClosed': {
      const l = p as unknown as CreditLoanClosed
      return row('LoanClosed', `${fmt(+l.principal)} USDx`, l.liquidated ? 'liquidated' : 'repaid')
    }
    default:
      return row('Request', kind.replace(/^Credit/, '').replace(/Request$/, ' request'), 'awaiting the operator')
  }
}

export async function readCnView(ledger: JsonLedger, party: string): Promise<Row[]> {
  const [contracts, holdings] = await Promise.all([ledger.query<unknown>(party, CN_TEMPLATES), ledger.queryInterface<HoldingView>(party, HOLDING_V1)])
  return [
    ...contracts.map((c) => describe(c, party)),
    ...holdings
      .filter((h) => h.view.owner === party)
      .map((h) => ({
        cid: h.contractId,
        kind: 'Holding',
        title: `${fmt(+h.view.amount)} ${label(h.view.instrumentId)}`,
        detail: h.view.lock ? 'locked for settlement' : 'CIP-56 holding',
      })),
  ]
}
