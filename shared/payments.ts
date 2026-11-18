// Orvane payments: contract types, template ids and command builders.

import type { DamlCommand } from './ledger.ts'
import { dec, type Dec } from './amm.ts'

const PKG = '#orvane-payments'

export const P = {
  PayoutPreference: `${PKG}:Orvane.Payroll:PayoutPreference`,
  Payslip: `${PKG}:Orvane.Payroll:Payslip`,
  PayrollAttestation: `${PKG}:Orvane.Payroll:PayrollAttestation`,
  PayoutRequest: `${PKG}:Orvane.Payroll:PayoutRequest`,
  PayrollOrder: `${PKG}:Orvane.Payroll:PayrollOrder`,
  Invoice: `${PKG}:Orvane.Invoice:Invoice`,
  PaidInvoice: `${PKG}:Orvane.Invoice:PaidInvoice`,
  DisputedInvoice: `${PKG}:Orvane.Invoice:DisputedInvoice`,
  InvoiceSettlement: `${PKG}:Orvane.Invoice:InvoiceSettlement`,
} as const

export interface PayoutPreference {
  employee: string
  employer: string
  symbol: string
}

export interface Payslip {
  employer: string
  employee: string
  runId: string
  period: string
  gross: Dec
  paySymbol: string
  received: Dec
  receivedSymbol: string
  note: string
  paidAt: string
}

export interface PayrollAttestation {
  employer: string
  auditors: string[]
  runId: string
  period: string
  headcount: number | string
  total: Dec
  symbol: string
  converted: number | string
  paidAt: string
}

export interface PayoutRequest {
  employer: string
  operator: string
  employee: string
  gross: Dec
  receiveSymbol: string
}

export interface InvoiceTerms {
  invoiceNo: string
  memo: string
  amount: Dec
  issuer: string
  symbol: string
  dueDate: string // YYYY-MM-DD
}

export interface Invoice {
  supplier: string
  buyer: string
  terms: InvoiceTerms
}

export interface PaidInvoice extends Invoice {
  paidSymbol: string
  paidAmount: Dec
  converted: boolean
  paidAt: string
}

export interface DisputedInvoice extends Invoice {
  reason: string
}

export interface InvoiceSettlement extends Invoice {
  operator: string
  maxIn: Dec
}

export interface PayLineInput {
  employee: string
  amount: number
  receiveSymbol: string
  minReceive: number
}

export function runPayroll(args: {
  employer: string
  operator: string
  poolId: string
  auditors: string[]
  runId: string
  period: string
  issuer: string
  symbol: string
  holdings: string[]
  lines: PayLineInput[]
}): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: P.PayrollOrder,
      createArguments: {
        ...args,
        lines: args.lines.map((l) => ({
          employee: l.employee,
          amount: dec(l.amount),
          receiveSymbol: l.receiveSymbol,
          minReceive: dec(l.minReceive),
        })),
      },
      choice: 'PayrollOrder_Run',
      choiceArgument: {},
    },
  }
}

export function setPreference(employee: string, employer: string, symbol: string, existing?: string): DamlCommand {
  if (existing) {
    return {
      ExerciseCommand: {
        templateId: P.PayoutPreference,
        contractId: existing,
        choice: 'PayoutPreference_Change',
        choiceArgument: { newSymbol: symbol },
      },
    }
  }
  return { CreateCommand: { templateId: P.PayoutPreference, createArguments: { employee, employer, symbol } } }
}

export function issueInvoice(supplier: string, buyer: string, terms: Omit<InvoiceTerms, 'amount'> & { amount: number }): DamlCommand {
  return {
    CreateCommand: {
      templateId: P.Invoice,
      createArguments: { supplier, buyer, terms: { ...terms, amount: dec(terms.amount) } },
    },
  }
}

const onInvoice = (cid: string, choice: string, choiceArgument: unknown): DamlCommand => ({
  ExerciseCommand: { templateId: P.Invoice, contractId: cid, choice, choiceArgument },
})

export const payInvoice = (cid: string, holdings: string[]) => onInvoice(cid, 'Invoice_Pay', { holdings })

export const payInvoiceConverted = (cid: string, operator: string, poolId: string, holdings: string[], maxIn: number) =>
  onInvoice(cid, 'Invoice_PayConverted', { operator, poolId, holdings, maxIn: dec(maxIn) })

export const disputeInvoice = (cid: string, reason: string) => onInvoice(cid, 'Invoice_Dispute', { reason })

export const withdrawInvoice = (cid: string) => onInvoice(cid, 'Invoice_Withdraw', {})

// Input needed to receive exactly `out` (mirrors Orvane.Pay.Util.getAmountIn).
export function amountIn(feeBps: number, out: number, reserveIn: number, reserveOut: number) {
  if (out <= 0 || out >= reserveOut) return Infinity
  return (reserveIn * out * 10_000) / ((reserveOut - out) * (10_000 - feeBps)) + 0.000001
}
