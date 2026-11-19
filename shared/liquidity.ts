// Liquidity for the token-standard exchange pool (Orvane.Liquidity):
// template ids, types and the provider's deposit order.

import type { DamlCommand, JsonLedger } from './ledger.ts'
import type { DisclosedContract, InstrumentId } from './amulet.ts'
import { prepareAllocationArgs } from './credit.ts'
import { dec10, type Registries } from './exchange.ts'

const PKG = '#orvane-liquidity'
export const LQ = {
  LpBook: `${PKG}:Orvane.Liquidity:LpBook`,
  LpShare: `${PKG}:Orvane.Liquidity:LpShare`,
  LpDepositOrder: `${PKG}:Orvane.Liquidity:LpDepositOrder`,
  LpDepositRequest: `${PKG}:Orvane.Liquidity:LpDepositRequest`,
  LpWithdrawRequest: `${PKG}:Orvane.Liquidity:LpWithdrawRequest`,
} as const

export interface LpBook {
  operator: string
  poolId: string
  totalShares: string
  members: string[]
}

export interface LpShare {
  operator: string
  owner: string
  poolId: string
  shares: string
}

export interface LpDepositRequest {
  provider: string
  operator: string
  poolId: string
  allocationA: string
  instrumentA: InstrumentId
  amountA: string
  allocationB: string
  instrumentB: InstrumentId
  amountB: string
  minShares: string
  ref: string
}

export interface LpWithdrawRequest {
  provider: string
  operator: string
  shareCid: string
  minA: string
  minB: string
}

const dedupe = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, d])).values()]

// Both sides allocated to the operator under one settlement, in one signature.
export async function prepareDeposit(args: {
  ledger: JsonLedger
  reg: Registries
  provider: string
  operator: string
  poolId: string
  instrA: InstrumentId
  amountA: number
  instrB: InstrumentId
  amountB: number
  minShares: number
  ref: string
}): Promise<{ command: DamlCommand; disclosed: DisclosedContract[] }> {
  const common = { ledger: args.ledger, reg: args.reg, sender: args.provider, operator: args.operator, ref: args.ref }
  const a = await prepareAllocationArgs({ ...common, instrument: args.instrA, amount: args.amountA, legId: 'a' })
  const b = await prepareAllocationArgs({ ...common, instrument: args.instrB, amount: args.amountB, legId: 'b' })
  return {
    command: {
      CreateAndExerciseCommand: {
        templateId: LQ.LpDepositOrder,
        createArguments: { provider: args.provider, operator: args.operator, poolId: args.poolId, sideA: a.fields, sideB: b.fields, minShares: dec10(args.minShares) },
        choice: 'LpDepositOrder_Place',
        choiceArgument: {},
      },
    },
    disclosed: dedupe([...a.disclosed, ...b.disclosed]),
  }
}

export const lpWithdrawRequest = (provider: string, operator: string, shareCid: string, minA = 0, minB = 0): DamlCommand => ({
  CreateCommand: { templateId: LQ.LpWithdrawRequest, createArguments: { provider, operator, shareCid, minA: dec10(minA), minB: dec10(minB) } },
})

export const cancelLpWithdraw = (requestCid: string): DamlCommand => ({
  ExerciseCommand: { templateId: LQ.LpWithdrawRequest, contractId: requestCid, choice: 'LpWithdrawRequest_Cancel', choiceArgument: {} },
})
