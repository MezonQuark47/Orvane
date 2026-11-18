// Orvane lending: contract types, template ids, command builders and math.
// Math mirrors daml/orvane-lending/daml/Orvane/Lending.daml.

import type { DamlCommand } from './ledger.ts'
import { dec, type Dec } from './amm.ts'
import type { PayLineInput } from './payments.ts'

const PKG = '#orvane-lending'

export const L = {
  LendingMarket: `${PKG}:Orvane.Lending:LendingMarket`,
  SupplyPosition: `${PKG}:Orvane.Lending:SupplyPosition`,
  SupplyOrder: `${PKG}:Orvane.Lending:SupplyOrder`,
  SupplyRequest: `${PKG}:Orvane.Lending:SupplyRequest`,
  WithdrawSupplyRequest: `${PKG}:Orvane.Lending:WithdrawSupplyRequest`,
  BorrowOrder: `${PKG}:Orvane.Lending:BorrowOrder`,
  BorrowRequest: `${PKG}:Orvane.Lending:BorrowRequest`,
  Loan: `${PKG}:Orvane.Lending:Loan`,
  LoanClosed: `${PKG}:Orvane.Lending:LoanClosed`,
  AdvanceLine: `${PKG}:Orvane.Advance:AdvanceLine`,
  AdvanceRequest: `${PKG}:Orvane.Advance:AdvanceRequest`,
  Advance: `${PKG}:Orvane.Advance:Advance`,
  AdvanceRepaid: `${PKG}:Orvane.Advance:AdvanceRepaid`,
  PayrollWithAdvances: `${PKG}:Orvane.Advance:PayrollWithAdvances`,
} as const

export interface LendingMarket {
  operator: string
  marketId: string
  assetSymbol: string
  collSymbol: string
  poolId: string
  cash: Dec
  principalOut: Dec
  totalShares: Dec
  baseAprBps: Dec
  slopeAprBps: Dec
  maxLtvBps: Dec
  liqLtvBps: Dec
  yearSeconds: number | string
  badDebt: Dec
  members: string[]
}

export interface SupplyPosition {
  operator: string
  owner: string
  marketId: string
  shares: Dec
}

export interface Loan {
  operator: string
  borrower: string
  marketId: string
  principal: Dec
  aprBps: Dec
  openedAt: string
  collateralCid: string
  collateralAmount: Dec
}

export interface LoanClosed {
  borrower: string
  principal: Dec
  interest: Dec
  collateralReturned: Dec
  liquidated: boolean
  closedAt: string
}

export interface AdvanceLine {
  employer: string
  employee: string
  operator: string
  marketId: string
  limit: Dec
  feeBps: Dec
  drawn: Dec
}

export interface Advance {
  operator: string
  employee: string
  employer: string
  principal: Dec
  fee: Dec
  drawnAt: string
}

export interface AdvanceRepaid {
  employee: string
  employer: string
  principal: Dec
  fee: Dec
  period: string
}

// ---------- math ----------

export interface MarketView {
  cash: number
  principalOut: number
  totalShares: number
  baseAprBps: number
  slopeAprBps: number
  maxLtv: number // fraction
  liqLtv: number // fraction
  yearSeconds: number
  badDebt: number
}

export const marketView = (m: LendingMarket): MarketView => ({
  cash: +m.cash,
  principalOut: +m.principalOut,
  totalShares: +m.totalShares,
  baseAprBps: +m.baseAprBps,
  slopeAprBps: +m.slopeAprBps,
  maxLtv: +m.maxLtvBps / 10_000,
  liqLtv: +m.liqLtvBps / 10_000,
  yearSeconds: +m.yearSeconds,
  badDebt: +m.badDebt,
})

export const utilization = (m: MarketView) => {
  const total = m.cash + m.principalOut
  return total ? m.principalOut / total : 0
}

export const borrowAprBps = (m: MarketView, extraBorrow = 0) => {
  const total = m.cash + m.principalOut
  const util = total ? (m.principalOut + extraBorrow) / total : 0
  return m.baseAprBps + m.slopeAprBps * util
}

// Suppliers earn the borrow rate on the borrowed share of the market.
export const supplyAprBps = (m: MarketView) => borrowAprBps(m) * utilization(m)

export const shareValue = (m: MarketView) => (m.totalShares ? (m.cash + m.principalOut) / m.totalShares : 1)

export function owedAt(yearSeconds: number, principal: number, aprBps: number, openedAt: string, now = Date.now()) {
  const years = Math.max(0, (now - Date.parse(openedAt)) / 1000 / yearSeconds)
  return principal + principal * (aprBps / 10_000) * years
}

// > 1 is safe; liquidation becomes possible below 1.
export const healthFactor = (collateralValue: number, liqLtv: number, owed: number) =>
  owed > 0 ? (collateralValue * liqLtv) / owed : Infinity

// Collateral price (USDx per CCx) at which a loan becomes liquidatable.
export const liquidationPrice = (collateralAmount: number, liqLtv: number, owed: number) =>
  collateralAmount > 0 ? owed / (collateralAmount * liqLtv) : 0

// ---------- commands ----------

export function supply(lender: string, operator: string, marketId: string, holdings: string[], amount: number): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: L.SupplyOrder,
      createArguments: { lender, operator, marketId, holdings, amount: dec(amount) },
      choice: 'SupplyOrder_Place',
      choiceArgument: {},
    },
  }
}

export const withdrawSupply = (lender: string, operator: string, positionCid: string): DamlCommand => ({
  CreateCommand: { templateId: L.WithdrawSupplyRequest, createArguments: { lender, operator, positionCid } },
})

export function borrow(args: {
  borrower: string
  operator: string
  marketId: string
  holdings: string[]
  collateralAmount: number
  borrowAmount: number
}): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: L.BorrowOrder,
      createArguments: { ...args, collateralAmount: dec(args.collateralAmount), borrowAmount: dec(args.borrowAmount) },
      choice: 'BorrowOrder_Place',
      choiceArgument: {},
    },
  }
}

export const repayLoan = (loanCid: string, holdings: string[], marketCid: string): DamlCommand => ({
  ExerciseCommand: { templateId: L.Loan, contractId: loanCid, choice: 'Loan_Repay', choiceArgument: { holdings, marketCid } },
})

export const addCollateral = (loanCid: string, holdings: string[], amount: number): DamlCommand => ({
  ExerciseCommand: { templateId: L.Loan, contractId: loanCid, choice: 'Loan_AddCollateral', choiceArgument: { holdings, amount: dec(amount) } },
})

export const requestAdvance = (employee: string, operator: string, lineCid: string, amount: number): DamlCommand => ({
  CreateCommand: { templateId: L.AdvanceRequest, createArguments: { employee, operator, lineCid, amount: dec(amount) } },
})

export const setAdvanceLimit = (lineCid: string, newLimit: number): DamlCommand => ({
  ExerciseCommand: { templateId: L.AdvanceLine, contractId: lineCid, choice: 'AdvanceLine_SetLimit', choiceArgument: { newLimit: dec(newLimit) } },
})

export function payrollWithAdvances(args: {
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
  advances: Array<{ advanceCid: string; lineCid: string }>
  marketCid: string
}): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: L.PayrollWithAdvances,
      createArguments: {
        ...args,
        lines: args.lines.map((l) => ({
          employee: l.employee,
          amount: dec(l.amount),
          receiveSymbol: l.receiveSymbol,
          minReceive: dec(l.minReceive),
        })),
      },
      choice: 'PayrollWithAdvances_Run',
      choiceArgument: {},
    },
  }
}
