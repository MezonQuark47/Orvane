// Orvane contract types, template ids, command builders and pricing math.
// Pricing mirrors daml/orvane-amm/daml/Orvane/Math.daml; the ledger is the
// source of truth, these numbers are only for quotes in the UI.

import type { DamlCommand } from './ledger.ts'

const PKG = '#orvane-defi-amm'

export const T = {
  Token: `${PKG}:Orvane.Token:Token`,
  Pool: `${PKG}:Orvane.Amm:Pool`,
  LpShare: `${PKG}:Orvane.Amm:LpShare`,
  SwapReceipt: `${PKG}:Orvane.Amm:SwapReceipt`,
  SwapRequest: `${PKG}:Orvane.Amm:SwapRequest`,
  SwapOrder: `${PKG}:Orvane.Amm:SwapOrder`,
  LiquidityOrder: `${PKG}:Orvane.Amm:LiquidityOrder`,
  AddLiquidityRequest: `${PKG}:Orvane.Amm:AddLiquidityRequest`,
  RemoveLiquidityRequest: `${PKG}:Orvane.Amm:RemoveLiquidityRequest`,
} as const

// Daml Decimal values travel as strings.
export type Dec = string

export interface Token {
  issuer: string
  owner: string
  symbol: string
  amount: Dec
  observers: string[]
}

export interface Pool {
  operator: string
  poolId: string
  issuerA: string
  symbolA: string
  issuerB: string
  symbolB: string
  reserveA: Dec
  reserveB: Dec
  holdingA: string | null
  holdingB: string | null
  totalShares: Dec
  feeBps: Dec
  members: string[]
}

export interface LpShare {
  operator: string
  owner: string
  poolId: string
  shares: Dec
}

export interface SwapReceipt {
  operator: string
  trader: string
  poolId: string
  symbolIn: string
  amountIn: Dec
  symbolOut: string
  amountOut: Dec
}

export interface SwapRequest {
  trader: string
  operator: string
  poolId: string
  inputCid: string
  minOutput: Dec
}

export interface AddLiquidityRequest {
  provider: string
  operator: string
  poolId: string
  cidA: string
  cidB: string
  minShares: Dec
}

export interface RemoveLiquidityRequest {
  provider: string
  operator: string
  lpCid: string
  minA: Dec
  minB: Dec
}

// Daml Decimal has 10 fractional digits.
export const dec = (n: number) => n.toFixed(10)

// ---------- math ----------

const BPS = 10_000

export function amountOut(feeBps: number, amountIn: number, reserveIn: number, reserveOut: number) {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0
  const inWithFee = (amountIn * (BPS - feeBps)) / BPS
  return (inWithFee * reserveOut) / (reserveIn + inWithFee)
}

// Price impact vs. the pool's current spot price, in percent.
export function priceImpact(feeBps: number, amountIn: number, reserveIn: number, reserveOut: number) {
  const out = amountOut(feeBps, amountIn, reserveIn, reserveOut)
  if (!out) return 0
  const spot = reserveOut / reserveIn
  const exec = out / amountIn
  return Math.max(0, (1 - exec / spot) * 100)
}

// ---------- commands ----------

export function placeSwap(args: {
  trader: string
  operator: string
  poolId: string
  holdings: string[]
  amount: number
  minOutput: number
}): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: T.SwapOrder,
      createArguments: {
        trader: args.trader,
        operator: args.operator,
        poolId: args.poolId,
        holdings: args.holdings,
        amount: dec(args.amount),
        minOutput: dec(args.minOutput),
      },
      choice: 'SwapOrder_Place',
      choiceArgument: {},
    },
  }
}

export function placeLiquidity(args: {
  provider: string
  operator: string
  poolId: string
  holdingsA: string[]
  amountA: number
  holdingsB: string[]
  amountB: number
  minShares: number
}): DamlCommand {
  return {
    CreateAndExerciseCommand: {
      templateId: T.LiquidityOrder,
      createArguments: {
        provider: args.provider,
        operator: args.operator,
        poolId: args.poolId,
        holdingsA: args.holdingsA,
        amountA: dec(args.amountA),
        holdingsB: args.holdingsB,
        amountB: dec(args.amountB),
        minShares: dec(args.minShares),
      },
      choice: 'LiquidityOrder_Place',
      choiceArgument: {},
    },
  }
}

export function requestWithdraw(args: {
  provider: string
  operator: string
  lpCid: string
  minA: number
  minB: number
}): DamlCommand {
  return {
    CreateCommand: {
      templateId: T.RemoveLiquidityRequest,
      createArguments: {
        provider: args.provider,
        operator: args.operator,
        lpCid: args.lpCid,
        minA: dec(args.minA),
        minB: dec(args.minB),
      },
    },
  }
}

export function exercise(templateId: string, contractId: string, choice: string, choiceArgument: unknown = {}): DamlCommand {
  return { ExerciseCommand: { templateId, contractId, choice, choiceArgument } }
}

// Party ids look like "Alice::1220ab...". Show the readable part.
export const partyName = (party: string) => party.split('::')[0]
