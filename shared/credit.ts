// Token-standard credit (Orvane.Credit): template ids, types and order builders.

import type { DamlCommand, JsonLedger } from './ledger.ts'
import { emptyExtraArgs, type DisclosedContract, type InstrumentId } from './amulet.ts'
import { allocationSpec, dec10, spendable, type Registries } from './exchange.ts'

const PKG = '#orvane-credit'
export const CR = {
  CreditMarket: `${PKG}:Orvane.Credit:CreditMarket`,
  CreditPosition: `${PKG}:Orvane.Credit:CreditPosition`,
  CreditSupplyOrder: `${PKG}:Orvane.Credit:CreditSupplyOrder`,
  CreditSupplyRequest: `${PKG}:Orvane.Credit:CreditSupplyRequest`,
  CreditWithdrawRequest: `${PKG}:Orvane.Credit:CreditWithdrawRequest`,
  CreditBorrowOrder: `${PKG}:Orvane.Credit:CreditBorrowOrder`,
  CreditBorrowRequest: `${PKG}:Orvane.Credit:CreditBorrowRequest`,
  CreditLoan: `${PKG}:Orvane.Credit:CreditLoan`,
  CreditRepayOrder: `${PKG}:Orvane.Credit:CreditRepayOrder`,
  CreditRepayRequest: `${PKG}:Orvane.Credit:CreditRepayRequest`,
  CreditLoanClosed: `${PKG}:Orvane.Credit:CreditLoanClosed`,
  CreditSurplus: `${PKG}:Orvane.Credit:CreditSurplus`,
} as const

export interface CreditMarket {
  operator: string
  marketId: string
  asset: InstrumentId
  collateral: InstrumentId
  poolId: string
  cash: string
  principalOut: string
  totalShares: string
  baseAprBps: string
  slopeAprBps: string
  maxLtvBps: string
  liqLtvBps: string
  yearSeconds: string | number
  badDebt: string
  members: string[]
}

export interface CreditPosition {
  operator: string
  owner: string
  marketId: string
  shares: string
}

export interface CreditLoan {
  operator: string
  borrower: string
  marketId: string
  principal: string
  aprBps: string
  openedAt: string
  collateralAmount: string
}

export interface CreditLoanClosed {
  borrower: string
  principal: string
  paid: string
  collateralReturned: string
  liquidated: boolean
  closedAt: string
}

export interface CreditSurplus {
  operator: string
  borrower: string
  amount: string
}

export interface CreditBorrowRequest {
  borrower: string
  operator: string
  marketId: string
  collateralAllocationCid: string
  collateralAmount: string
  borrowAmount: string
  ref: string
}

export interface CreditRepayRequest {
  borrower: string
  operator: string
  loanCid: string
  repayAllocationCid: string
  amount: string
  ref: string
}

export interface CreditSupplyRequest {
  lender: string
  operator: string
  marketId: string
  allocationCid: string
  amount: string
  ref: string
}

export interface CreditWithdrawRequest {
  lender: string
  operator: string
  positionCid: string
}

// Allocate `amount` of `instrument` from `sender` to the operator, ready to
// embed in an order template. One signature from the sender.
export async function prepareAllocationArgs(args: {
  ledger: JsonLedger
  reg: Registries
  sender: string
  operator: string
  instrument: InstrumentId
  amount: number
  ref: string
  /** distinct per leg when one settlement allocates several */
  legId?: string
}): Promise<{ fields: Record<string, unknown>; disclosed: DisclosedContract[] }> {
  const holdings = await spendable(args.ledger, args.sender, args.instrument)
  if (!holdings.length) throw new Error(`No spendable ${args.instrument.id === 'Amulet' ? 'CC' : args.instrument.id}`)
  const allocation = allocationSpec({
    executor: args.operator,
    ref: args.ref,
    sender: args.sender,
    receiver: args.operator,
    instrument: args.instrument,
    amount: args.amount,
    legId: args.legId ?? 'leg',
  })
  const requestedAt = new Date(Date.now() - 5_000).toISOString()
  const inputHoldingCids = holdings.map((h) => h.contractId)
  const prepared = await args.reg.forInstrument(args.instrument, args.sender).allocationFactory({
    expectedAdmin: args.instrument.admin,
    allocation,
    requestedAt,
    inputHoldingCids,
    extraArgs: emptyExtraArgs,
  })
  return {
    disclosed: prepared.disclosed,
    fields: {
      factoryCid: prepared.factoryId,
      expectedAdmin: args.instrument.admin,
      allocation,
      requestedAt,
      inputHoldingCids,
      extraArgs: prepared.extraArgs,
    },
  }
}

const order = (templateId: string, choice: string, createArguments: Record<string, unknown>): DamlCommand => ({
  CreateAndExerciseCommand: { templateId, createArguments, choice, choiceArgument: {} },
})

export const newRef = (kind: string) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const supplyOrder = (lender: string, operator: string, marketId: string, fields: Record<string, unknown>) =>
  order(CR.CreditSupplyOrder, 'CreditSupplyOrder_Place', { lender, operator, marketId, ...fields })

export const borrowOrder = (borrower: string, operator: string, marketId: string, fields: Record<string, unknown>, borrowAmount: number) =>
  order(CR.CreditBorrowOrder, 'CreditBorrowOrder_Place', { borrower, operator, marketId, ...fields, borrowAmount: dec10(borrowAmount) })

export const repayOrder = (borrower: string, operator: string, loanCid: string, fields: Record<string, unknown>) =>
  order(CR.CreditRepayOrder, 'CreditRepayOrder_Place', { borrower, operator, loanCid, ...fields })

export const withdrawRequest = (lender: string, operator: string, positionCid: string): DamlCommand => ({
  CreateCommand: { templateId: CR.CreditWithdrawRequest, createArguments: { lender, operator, positionCid } },
})
