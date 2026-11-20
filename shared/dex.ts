// The Orvane DEX on the ledger: template ids, payload shapes, the pool math
// (a line-for-line mirror of Orvane.Dex.Math) and the commands wallets and
// the operator submit. Shared by the operator (Node) and the web app.

import { ZERO, TICK, dec, div, fromInt, mul, show, sum, abs, type Dec } from './decimal.ts'

const pkg = '#orvane'
export const DEX = {
  PoolRules: `${pkg}:Orvane.Dex.Pool:PoolRules`,
  PoolState: `${pkg}:Orvane.Dex.State:PoolState`,
  LpPosition: `${pkg}:Orvane.Dex.State:LpPosition`,
  SwapReceipt: `${pkg}:Orvane.Dex.State:SwapReceipt`,
  PositionClosed: `${pkg}:Orvane.Dex.State:PositionClosed`,
  OrderDesk: `${pkg}:Orvane.Dex.Orders:OrderDesk`,
  SwapRequest: `${pkg}:Orvane.Dex.Orders:SwapRequest`,
  DepositRequest: `${pkg}:Orvane.Dex.Orders:DepositRequest`,
  WithdrawRequest: `${pkg}:Orvane.Dex.Orders:WithdrawRequest`,
  RenewRequest: `${pkg}:Orvane.Dex.Orders:RenewRequest`,
  RequestRejected: `${pkg}:Orvane.Dex.Orders:RequestRejected`,
} as const

export const ALLOCATION_V2 = '#splice-api-token-allocation-v2:Splice.Api.Token.AllocationV2:Allocation'
export const HOLDING_V2 = '#splice-api-token-holding-v2:Splice.Api.Token.HoldingV2:Holding'
export const TRANSFER_INSTRUCTION_V2 = '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferInstruction'

// ---------- payloads (as the JSON Ledger API returns them) ----------

export interface InstrumentId {
  admin: string
  id: string
}
export interface Account {
  owner: string | null
  provider: string | null
  id: string
}
export const basicAccount = (owner: string): Account => ({ owner, provider: null, id: '' })
export const sameInstrument = (a: InstrumentId, b: InstrumentId) => a.admin === b.admin && a.id === b.id

export interface PoolRules {
  operator: string
  poolId: string
  instrumentA: InstrumentId
  instrumentB: InstrumentId
  feeBps: string
  maxPositions: string
  minTerm: { microseconds: string }
  maxTerm: { microseconds: string }
  ratioToleranceBps: string
}
export interface PoolState {
  operator: string
  poolId: string
  reserveA: string
  reserveB: string
  positions: string
  status: 'Active' | 'Paused'
  swaps: string
}
export interface LpPosition {
  operator: string
  provider: string
  poolId: string
  positionId: string
  instrumentA: InstrumentId
  allocationA: string
  amountA: string
  instrumentB: InstrumentId
  allocationB: string
  amountB: string
  termEnd: string
  openedAt: string
}
export interface SwapReceipt {
  operator: string
  trader: string
  poolId: string
  requestId: string
  instrumentIn: InstrumentId
  amountIn: string
  instrumentOut: InstrumentId
  amountOut: string
  settledAt: string
}
export interface SwapRequest {
  trader: string
  operator: string
  poolId: string
  requestId: string
  instrumentIn: InstrumentId
  amountIn: string
  instrumentOut: InstrumentId
  minOut: string
  deadline: string
  inputAllocation: string
}
export interface DepositRequest {
  provider: string
  operator: string
  poolId: string
  requestId: string
  instrumentA: InstrumentId
  amountA: string
  allocationA: string
  instrumentB: InstrumentId
  amountB: string
  allocationB: string
  termEnd: string
}
export interface WithdrawRequest {
  provider: string
  operator: string
  poolId: string
  positionId: string
}
export interface RenewRequest extends WithdrawRequest {
  termEnd: string
}
export interface PositionClosed {
  provider: string
  poolId: string
  positionId: string
  instrumentA: InstrumentId
  amountA: string
  instrumentB: InstrumentId
  amountB: string
  reason: 'Withdrawn' | 'TermEnded'
  closedAt: string
}
export interface RequestRejected {
  party: string
  poolId: string
  requestId: string
  reason: string
}

// ---------- token-standard values ----------

export type AnyValue = { tag: string; value: unknown }
export interface ExtraArgs {
  context: { values: Record<string, AnyValue> }
  meta: { values: Record<string, string> }
}
export const emptyExtraArgs = (): ExtraArgs => ({ context: { values: {} }, meta: { values: {} } })

export interface DisclosedContract {
  templateId: string
  contractId: string
  createdEventBlob: string
  synchronizerId: string
}

// A registry factory, ready to exercise: its contract id, the choice context
// to pass as extraArgs, and the contracts to disclose with the command.
export interface FactoryCall {
  factoryId: string
  extraArgs: ExtraArgs
  disclosed: DisclosedContract[]
}
export interface ChoiceArgs {
  extraArgs: ExtraArgs
  disclosed: DisclosedContract[]
}

// The settlement every allocation of a pool carries (see Orvane.Dex.Token).
export const poolSettlement = (operator: string, poolId: string) => ({
  executors: [operator],
  id: `orvane/${poolId}`,
  cid: null,
  meta: { values: {} },
})

const relTime = (seconds: number) => ({ microseconds: String(seconds * 1_000_000) })
export const seconds = (t: { microseconds: string }) => Number(t.microseconds) / 1_000_000

// ---------- pool math (mirror of Orvane.Dex.Math) ----------

const BPS = fromInt(10_000)

function divDown(a: Dec, b: Dec): Dec {
  const q = div(a, b)
  return mul(q, b) > a ? q - TICK : q
}

export function productHolds(reserveIn: Dec, reserveOut: Dec, amountIn: Dec, out: Dec): boolean {
  return mul(reserveIn + amountIn, reserveOut - out) >= mul(reserveIn, reserveOut)
}

export function quoteOut(feeBps: number, reserveIn: Dec, reserveOut: Dec, amountIn: Dec): Dec {
  const keep = fromInt(10_000 - feeBps)
  let out = divDown(mul(mul(amountIn, keep), reserveOut), mul(reserveIn, BPS) + mul(amountIn, keep))
  for (let n = 0; ; n++) {
    if (out <= ZERO) return ZERO
    if (n >= 5 || productHolds(reserveIn, reserveOut, amountIn, out)) return out
    out -= TICK
  }
}

export function splitProRata(total: Dec, weights: Dec[]): Dec[] {
  if (!weights.length) return []
  const whole = sum(weights)
  const parts = weights.map((w) => divDown(mul(total, w), whole))
  const rest = total - sum(parts)
  let biggest = 0
  weights.forEach((w, i) => {
    if (w > weights[biggest]) biggest = i
  })
  return parts.map((p, i) => (i === biggest ? p + rest : p))
}

export function withinRatio(toleranceBps: number, reserveA: Dec, reserveB: Dec, a: Dec, b: Dec): boolean {
  const expected = mul(a, reserveB)
  const actual = mul(b, reserveA)
  return mul(abs(actual - expected), BPS) <= mul(fromInt(toleranceBps), expected)
}

export interface Quote {
  amountOut: Dec
  // marginal price before the trade and the price this trade gets, both in
  // units of the output asset per unit of input
  spotPrice: Dec
  tradePrice: Dec
  priceImpactBps: number
}

export function quote(pool: { feeBps: number; reserveIn: Dec; reserveOut: Dec }, amountIn: Dec): Quote {
  const amountOut = quoteOut(pool.feeBps, pool.reserveIn, pool.reserveOut, amountIn)
  const spotPrice = pool.reserveIn > ZERO ? div(pool.reserveOut, pool.reserveIn) : ZERO
  const tradePrice = amountIn > ZERO ? div(amountOut, amountIn) : ZERO
  const impact = spotPrice > ZERO ? Number(((spotPrice - tradePrice) * 10_000n) / spotPrice) : 0
  return { amountOut, spotPrice, tradePrice, priceImpactBps: impact }
}

// Lowest acceptable output for a slippage tolerance in basis points.
export const minOutFor = (amountOut: Dec, slippageBps: number) => (amountOut * BigInt(10_000 - slippageBps)) / 10_000n

// ---------- commands ----------

export interface PoolTerms {
  operator: string
  poolId: string
  instrumentA: InstrumentId
  instrumentB: InstrumentId
  feeBps: number
  maxPositions: number
  minTermSeconds: number
  maxTermSeconds: number
  ratioToleranceBps: number
}

export const createPoolRules = (t: PoolTerms) => ({
  CreateCommand: {
    templateId: DEX.PoolRules,
    createArguments: {
      operator: t.operator,
      poolId: t.poolId,
      instrumentA: t.instrumentA,
      instrumentB: t.instrumentB,
      feeBps: String(t.feeBps),
      maxPositions: String(t.maxPositions),
      minTerm: relTime(t.minTermSeconds),
      maxTerm: relTime(t.maxTermSeconds),
      ratioToleranceBps: String(t.ratioToleranceBps),
    },
  },
})

// Orders are one exercise on the pool's order desk: wallets of external
// parties can only sign transactions with a single root action. The desk
// belongs to the operator, so the wallet submits it as a disclosed contract.

// A trader's order, placed from their wallet in one transaction.
export function placeSwap(o: {
  desk: string
  trader: string
  requestId: string
  instrumentIn: InstrumentId
  amountIn: Dec
  instrumentOut: InstrumentId
  minOut: Dec
  deadline: Date
  factory: FactoryCall
  inputHoldingCids: string[]
  requestedAt: Date
}) {
  return {
    ExerciseCommand: {
      templateId: DEX.OrderDesk,
      contractId: o.desk,
      choice: 'OrderDesk_Swap',
      choiceArgument: {
        trader: o.trader,
        requestId: o.requestId,
        instrumentIn: o.instrumentIn,
        amountIn: show(o.amountIn),
        instrumentOut: o.instrumentOut,
        minOut: show(o.minOut),
        deadline: o.deadline.toISOString(),
        allocationFactory: o.factory.factoryId,
        inputHoldingCids: o.inputHoldingCids,
        requestedAt: o.requestedAt.toISOString(),
        extraArgs: o.factory.extraArgs,
      },
    },
  }
}

// A provider's deposit, placed from their wallet in one transaction.
export function placeDeposit(o: {
  desk: string
  provider: string
  requestId: string
  instrumentA: InstrumentId
  amountA: Dec
  instrumentB: InstrumentId
  amountB: Dec
  termEnd: Date
  factoryA: FactoryCall
  holdingsA: string[]
  factoryB: FactoryCall
  holdingsB: string[]
  requestedAt: Date
}) {
  return {
    ExerciseCommand: {
      templateId: DEX.OrderDesk,
      contractId: o.desk,
      choice: 'OrderDesk_Deposit',
      choiceArgument: {
        provider: o.provider,
        requestId: o.requestId,
        instrumentA: o.instrumentA,
        amountA: show(o.amountA),
        instrumentB: o.instrumentB,
        amountB: show(o.amountB),
        termEnd: o.termEnd.toISOString(),
        factoryA: o.factoryA.factoryId,
        holdingsA: o.holdingsA,
        extraArgsA: o.factoryA.extraArgs,
        factoryB: o.factoryB.factoryId,
        holdingsB: o.holdingsB,
        extraArgsB: o.factoryB.extraArgs,
        requestedAt: o.requestedAt.toISOString(),
      },
    },
  }
}

export const requestWithdraw = (provider: string, operator: string, poolId: string, positionId: string) => ({
  CreateCommand: { templateId: DEX.WithdrawRequest, createArguments: { provider, operator, poolId, positionId } },
})

export const requestRenew = (provider: string, operator: string, poolId: string, positionId: string, termEnd: Date) => ({
  CreateCommand: { templateId: DEX.RenewRequest, createArguments: { provider, operator, poolId, positionId, termEnd: termEnd.toISOString() } },
})

// The specs a registry is asked about when the wallet places an order. The
// registry uses them to pick the right factory and context.
export const allocateArgs = (o: {
  settlement: ReturnType<typeof poolSettlement>
  admin: string
  owner: string
  sides: unknown[]
  deadline: Date | null
  funding: Record<string, string> | null
  committed: boolean
  requestedAt: Date
  inputHoldingCids: string[]
}) => ({
  settlement: o.settlement,
  allocation: {
    admin: o.admin,
    authorizer: basicAccount(o.owner),
    transferLegSides: o.sides,
    settlementDeadline: o.deadline?.toISOString() ?? null,
    nextIterationFunding: o.funding,
    committed: o.committed,
    meta: { values: {} },
  },
  requestedAt: o.requestedAt.toISOString(),
  inputHoldingCids: o.inputHoldingCids,
  extraArgs: emptyExtraArgs(),
  actors: [o.owner],
})

export const decOf = dec
export { show as showDec }
