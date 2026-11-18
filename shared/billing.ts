// Token-standard invoices (Orvane.Billing) and wage advances (Orvane.Advances).

import type { DamlCommand } from './ledger.ts'
import type { InstrumentId } from './amulet.ts'
import { dec10 } from './exchange.ts'

const TPKG = '#orvane-treasury'
const CPKG = '#orvane-credit'

export const B = {
  InvoiceCn: `${TPKG}:Orvane.Billing:InvoiceCn`,
  InvoicePaymentCn: `${TPKG}:Orvane.Billing:InvoicePaymentCn`,
  InvoiceConversionCn: `${TPKG}:Orvane.Billing:InvoiceConversionCn`,
  PaidInvoiceCn: `${TPKG}:Orvane.Billing:PaidInvoiceCn`,
  DisputedInvoiceCn: `${TPKG}:Orvane.Billing:DisputedInvoiceCn`,
  AdvanceLineCn: `${CPKG}:Orvane.Advances:AdvanceLineCn`,
  AdvanceRequestCn: `${CPKG}:Orvane.Advances:AdvanceRequestCn`,
  AdvanceCn: `${CPKG}:Orvane.Advances:AdvanceCn`,
  AdvanceRepaidCn: `${CPKG}:Orvane.Advances:AdvanceRepaidCn`,
} as const

export interface BillTerms {
  invoiceNo: string
  memo: string
  amount: string
  instrument: InstrumentId
  dueDate: string
}

export interface InvoiceCn {
  supplier: string
  buyer: string
  terms: BillTerms
}

export interface InvoicePaymentCn extends InvoiceCn {
  allocationCid: string
}

export interface InvoiceConversionCn extends InvoiceCn {
  operator: string
  poolId: string
  inputAllocationCid: string
  inputInstrument: InstrumentId
  amountIn: string
  ref: string
}

export interface PaidInvoiceCn extends InvoiceCn {
  paidInstrument: InstrumentId
  paidAmount: string
  converted: boolean
  paidAt: string
}

export interface DisputedInvoiceCn extends InvoiceCn {
  reason: string
}

export interface AdvanceLineCn {
  employer: string
  employee: string
  operator: string
  marketId: string
  limit: string
  feeBps: string
  drawn: string
}

export interface AdvanceCn {
  operator: string
  employee: string
  employer: string
  principal: string
  fee: string
  drawnAt: string
}

export interface AdvanceRequestCn {
  employee: string
  operator: string
  lineCid: string
  amount: string
}

export const issueInvoiceCn = (supplier: string, buyer: string, t: { invoiceNo: string; memo: string; amount: number; instrument: InstrumentId; dueDate: string }): DamlCommand => ({
  CreateCommand: { templateId: B.InvoiceCn, createArguments: { supplier, buyer, terms: { ...t, amount: dec10(t.amount) } } },
})

const onInvoice = (cid: string, choice: string, choiceArgument: unknown): DamlCommand => ({
  ExerciseCommand: { templateId: B.InvoiceCn, contractId: cid, choice, choiceArgument },
})

// fields = { factoryCid, expectedAdmin, allocation, requestedAt, inputHoldingCids, extraArgs } from prepareAllocationArgs
export const lockInvoice = (cid: string, fields: Record<string, unknown>) => {
  const { expectedAdmin: _ignored, ...rest } = fields
  void _ignored
  return onInvoice(cid, 'InvoiceCn_Lock', rest)
}

export const payInvoiceConverted = (cid: string, operator: string, poolId: string, fields: Record<string, unknown>) =>
  onInvoice(cid, 'InvoiceCn_PayConverted', { operator, poolId, ...fields })

export const disputeInvoiceCn = (cid: string, reason: string) => onInvoice(cid, 'InvoiceCn_Dispute', { reason })

export const withdrawInvoiceCn = (cid: string) => onInvoice(cid, 'InvoiceCn_Withdraw', {})

export const settleInvoicePayment = (cid: string, extraArgs: unknown): DamlCommand => ({
  ExerciseCommand: { templateId: B.InvoicePaymentCn, contractId: cid, choice: 'InvoicePaymentCn_Settle', choiceArgument: { extraArgs } },
})

export const reissueInvoiceCn = (cid: string, newTerms: BillTerms): DamlCommand => ({
  ExerciseCommand: { templateId: B.DisputedInvoiceCn, contractId: cid, choice: 'DisputedInvoiceCn_Reissue', choiceArgument: { newTerms } },
})

export const requestAdvanceCn = (employee: string, operator: string, lineCid: string, amount: number): DamlCommand => ({
  CreateCommand: { templateId: B.AdvanceRequestCn, createArguments: { employee, operator, lineCid, amount: dec10(amount) } },
})

export const repayAdvanceCn = (cid: string, args: { allocationCid: string; marketCid: string; lineCid: string; extraArgs: unknown; period: string }): DamlCommand => ({
  ExerciseCommand: { templateId: B.AdvanceCn, contractId: cid, choice: 'AdvanceCn_Repay', choiceArgument: args },
})
