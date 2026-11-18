// Token-standard exchange: template ids, command builders, and a registry
// abstraction so callers don't care whether an instrument is Canton Coin
// (registry API served by Scan) or Orvane USDx (our on-ledger registry).

import type { DamlCommand, JsonLedger } from './ledger.ts'
import {
  ALLOCATION_FACTORY_V1,
  emptyExtraArgs,
  extraArgsFrom,
  holdingsOf,
  type DisclosedContract,
  type InstrumentId,
  type Scan,
} from './amulet.ts'

const PKG = '#orvane-exchange'
export const X = {
  ExchangePool: `${PKG}:Orvane.Exchange:ExchangePool`,
  ExchangeSwapOrder: `${PKG}:Orvane.Exchange:ExchangeSwapOrder`,
  ExchangeSwapRequest: `${PKG}:Orvane.Exchange:ExchangeSwapRequest`,
  ExchangeReceipt: `${PKG}:Orvane.Exchange:ExchangeReceipt`,
} as const

export const ORVANE_RULES = '#orvane-registry:Orvane.Registry:OrvaneRules'

export interface ExchangePool {
  operator: string
  poolId: string
  instrA: InstrumentId
  instrB: InstrumentId
  reserveA: string
  reserveB: string
  feeBps: string
  members: string[]
}

export interface ExchangeSwapRequest {
  trader: string
  operator: string
  poolId: string
  inputAllocationCid: string
  inputInstrument: InstrumentId
  amountIn: string
  minOut: string
  settlementRef: string
}

export interface ExchangeReceipt {
  trader: string
  poolId: string
  settlementRef: string
  instrumentIn: InstrumentId
  amountIn: string
  instrumentOut: InstrumentId
  amountOut: string
}

export const sameInstrument = (a: InstrumentId, b: InstrumentId) => a.admin === b.admin && a.id === b.id

// Daml Decimal has 10 fractional digits; round amounts we send *down* to 6.
export const floorAmount = (n: number) => Math.floor(n * 1e6) / 1e6
export const dec10 = (n: number) => n.toFixed(10)

// ---------- registries ----------

export interface Prepared {
  factoryId: string
  extraArgs: unknown
  disclosed: DisclosedContract[]
}

export interface Registry {
  // Factory + context for AllocationFactory_Allocate with these arguments.
  allocationFactory(choiceArguments: unknown): Promise<Prepared>
  // Context for executing / cancelling an existing allocation.
  allocationArgs(allocationCid: string, action: 'execute-transfer' | 'cancel' | 'withdraw'): Promise<{ extraArgs: unknown; disclosed: DisclosedContract[] }>
}

export function amuletRegistry(scan: Scan): Registry {
  return {
    async allocationFactory(choiceArguments) {
      const f = await scan.allocationFactory(choiceArguments)
      return { factoryId: f.factoryId, extraArgs: extraArgsFrom(f.choiceContext), disclosed: f.choiceContext.disclosedContracts }
    },
    async allocationArgs(cid, action) {
      const ctx = await scan.allocationContext(cid, action)
      return { extraArgs: extraArgsFrom(ctx), disclosed: ctx.disclosedContracts }
    },
  }
}

// Orvane's registry needs no off-ledger context: the rules contract is the
// factory and holders see it directly.
export function orvaneRegistry(ledger: JsonLedger, reader: string, admin: string): Registry {
  return {
    async allocationFactory() {
      const rules = (await ledger.query<{ admin: string }>(reader, [ORVANE_RULES])).find((r) => r.payload.admin === admin)
      if (!rules) throw new Error('Orvane registry rules not visible to ' + reader)
      return { factoryId: rules.contractId, extraArgs: emptyExtraArgs, disclosed: [] }
    },
    async allocationArgs() {
      return { extraArgs: emptyExtraArgs, disclosed: [] }
    },
  }
}

export interface Registries {
  forInstrument(i: InstrumentId, reader: string): Registry
}

export function registries(ledger: JsonLedger, scan: Scan, amuletAdmin: string): Registries {
  return {
    forInstrument(i, reader) {
      return i.admin === amuletAdmin ? amuletRegistry(scan) : orvaneRegistry(ledger, reader, i.admin)
    },
  }
}

// ---------- allocation helpers ----------

export function allocationSpec(args: {
  executor: string
  ref: string
  sender: string
  receiver: string
  instrument: InstrumentId
  amount: number
  legId: string
  now?: number
}) {
  const now = args.now ?? Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    settlement: {
      executor: args.executor,
      settlementRef: { id: args.ref, cid: null },
      requestedAt: iso(now - 5_000),
      allocateBefore: iso(now + 10 * 60_000),
      settleBefore: iso(now + 30 * 60_000),
      meta: { values: {} },
    },
    transferLegId: args.legId,
    transferLeg: {
      sender: args.sender,
      receiver: args.receiver,
      amount: dec10(args.amount),
      instrumentId: args.instrument,
      meta: { values: {} },
    },
  }
}

// Holdings of one instrument that `owner` can spend (unlocked).
export async function spendable(ledger: JsonLedger, owner: string, i: InstrumentId) {
  const hs = await holdingsOf(ledger, owner)
  return hs.filter((h) => sameInstrument(h.view.instrumentId, i) && !h.view.lock)
}

// Build the trader's single command: allocate input + file the swap request.
export async function prepareSwapOrder(args: {
  ledger: JsonLedger
  reg: Registries
  trader: string
  operator: string
  poolId: string
  input: InstrumentId
  amount: number
  minOut: number
}): Promise<{ command: DamlCommand; disclosed: DisclosedContract[]; ref: string }> {
  const ref = `swap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const holdings = await spendable(args.ledger, args.trader, args.input)
  if (!holdings.length) throw new Error('No spendable holdings of the input asset')
  const allocation = allocationSpec({
    executor: args.operator,
    ref,
    sender: args.trader,
    receiver: args.operator,
    instrument: args.input,
    amount: args.amount,
    legId: 'in',
  })
  const requestedAt = new Date(Date.now() - 5_000).toISOString()
  const inputHoldingCids = holdings.map((h) => h.contractId)
  const registry = args.reg.forInstrument(args.input, args.trader)
  const prepared = await registry.allocationFactory({
    expectedAdmin: args.input.admin,
    allocation,
    requestedAt,
    inputHoldingCids,
    extraArgs: emptyExtraArgs,
  })
  return {
    ref,
    disclosed: prepared.disclosed,
    command: {
      CreateAndExerciseCommand: {
        templateId: X.ExchangeSwapOrder,
        createArguments: {
          trader: args.trader,
          operator: args.operator,
          poolId: args.poolId,
          factoryCid: prepared.factoryId,
          expectedAdmin: args.input.admin,
          allocation,
          requestedAt,
          inputHoldingCids,
          extraArgs: prepared.extraArgs,
          minOut: dec10(args.minOut),
        },
        choice: 'ExchangeSwapOrder_Place',
        choiceArgument: {},
      },
    },
  }
}

export { ALLOCATION_FACTORY_V1 }
