// What a user can do, as wallet transactions. Each function builds the
// commands, asks the instrument's registry for the factory and context it
// needs, has the wallet sign, then waits until the operator has settled (or
// handed the request back).

import { show, type Dec } from '../../../shared/decimal.ts'
import {
  TRANSFER_INSTRUCTION_V2,
  allocateArgs,
  basicAccount,
  placeDeposit,
  placeSwap,
  requestRenew,
  requestWithdraw,
  DEX,
  type InstrumentId,
  type LpPosition,
  type SwapReceipt,
  type SwapRequest,
} from '../../../shared/dex.ts'
import { dedupeDisclosed } from '../../../shared/registry.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { waitFor, type DexState, type Mine, type PoolConfig } from './dex.tsx'

const newRequestId = (kind: string) => `${kind}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`
// a little in the past, so the registry never sees a time ahead of the ledger
const requestedNow = () => new Date(Date.now() - 5_000)

export class Rejected extends Error {}

function rejectedOrNothing(m: Mine, requestId: string) {
  const r = m.rejections.find((x) => x.payload.requestId === requestId)
  if (r) throw new Rejected(r.payload.reason)
  return undefined
}

export async function swap(
  dex: DexState,
  o: { pool: PoolConfig; instrumentIn: InstrumentId; instrumentOut: InstrumentId; amountIn: Dec; minOut: Dec },
  onSigned?: () => void,
): Promise<SwapReceipt> {
  const trader = dex.party!
  const requestId = newRequestId('swap')
  const requestedAt = requestedNow()
  const deadline = new Date(Date.now() + 10 * 60_000)
  const holdings = dex.latest().holdings.filter((h) => !h.locked && h.instrument.admin === o.instrumentIn.admin && h.instrument.id === o.instrumentIn.id)
  const side = {
    transferLegId: `${requestId}/in`,
    side: 'SenderSide',
    otherside: basicAccount(o.pool.operator),
    amount: show(o.amountIn),
    instrumentId: o.instrumentIn.id,
    meta: { values: {} },
  }
  const factory = await dex.registry(o.instrumentIn.admin).allocationFactory(
    allocateArgs({
      settlement: o.pool.settlement,
      admin: o.instrumentIn.admin,
      owner: trader,
      sides: [side],
      deadline,
      funding: null,
      committed: false,
      requestedAt,
      inputHoldingCids: holdings.map((h) => h.cid),
    }),
  )
  await dex.submit(
    [
      placeSwap({
        desk: o.pool.desk.contractId,
        trader,
        requestId,
        instrumentIn: o.instrumentIn,
        amountIn: o.amountIn,
        instrumentOut: o.instrumentOut,
        minOut: o.minOut,
        deadline,
        factory,
        inputHoldingCids: holdings.map((h) => h.cid),
        requestedAt,
      }),
    ],
    dedupeDisclosed([o.pool.desk, ...factory.disclosed]),
    `orvane-${requestId}`,
  )
  onSigned?.()
  const receipt = await waitFor(() => {
    const m = dex.latest()
    return m.receipts.find((r) => r.payload.requestId === requestId) ?? rejectedOrNothing(m, requestId)
  })
  return receipt.payload
}

export async function deposit(
  dex: DexState,
  o: { pool: PoolConfig; amountA: Dec; amountB: Dec; termEnd: Date },
  onSigned?: () => void,
): Promise<Contract<LpPosition>> {
  const provider = dex.party!
  const requestId = newRequestId('lp')
  const requestedAt = requestedNow()
  const { instrumentA, instrumentB } = o.pool
  const freeOf = (i: InstrumentId) => dex.latest().holdings.filter((h) => !h.locked && h.instrument.admin === i.admin && h.instrument.id === i.id).map((h) => h.cid)
  const holdingsA = freeOf(instrumentA)
  const holdingsB = freeOf(instrumentB)
  const spec = (i: InstrumentId, amount: Dec, holdings: string[]) =>
    allocateArgs({
      settlement: o.pool.settlement,
      admin: i.admin,
      owner: provider,
      sides: [],
      deadline: o.termEnd,
      funding: { [i.id]: show(amount) },
      committed: true,
      requestedAt,
      inputHoldingCids: holdings,
    })
  const [factoryA, factoryB] = await Promise.all([
    dex.registry(instrumentA.admin).allocationFactory(spec(instrumentA, o.amountA, holdingsA)),
    dex.registry(instrumentB.admin).allocationFactory(spec(instrumentB, o.amountB, holdingsB)),
  ])
  await dex.submit(
    [
      placeDeposit({
        desk: o.pool.desk.contractId,
        provider,
        requestId,
        instrumentA,
        amountA: o.amountA,
        instrumentB,
        amountB: o.amountB,
        termEnd: o.termEnd,
        factoryA,
        holdingsA,
        factoryB,
        holdingsB,
        requestedAt,
      }),
    ],
    dedupeDisclosed([o.pool.desk, ...factoryA.disclosed, ...factoryB.disclosed]),
    `orvane-${requestId}`,
  )
  onSigned?.()
  return waitFor(() => {
    const m = dex.latest()
    return m.positions.find((p) => p.payload.positionId === requestId) ?? rejectedOrNothing(m, requestId)
  })
}

export async function withdraw(dex: DexState, position: LpPosition, onSigned?: () => void) {
  await dex.submit([requestWithdraw(dex.party!, position.operator, position.poolId, position.positionId)])
  onSigned?.()
  await waitFor(() => {
    const m = dex.latest()
    return m.positions.some((p) => p.payload.positionId === position.positionId) ? undefined : true
  }, 90_000)
}

export async function renew(dex: DexState, position: LpPosition, termEnd: Date, onSigned?: () => void) {
  await dex.submit([requestRenew(dex.party!, position.operator, position.poolId, position.positionId, termEnd)])
  onSigned?.()
  await waitFor(() => {
    const p = dex.latest().positions.find((x) => x.payload.positionId === position.positionId)
    return p && Date.parse(p.payload.termEnd) === termEnd.getTime() ? p : undefined
  }, 90_000)
}

export async function cancelSwap(dex: DexState, request: Contract<SwapRequest>) {
  const ctx = await dex.registry(request.payload.instrumentIn.admin).allocationChoice(request.payload.inputAllocation, 'withdraw')
  await dex.submit(
    [{ ExerciseCommand: { templateId: DEX.SwapRequest, contractId: request.contractId, choice: 'SwapRequest_Cancel', choiceArgument: { withdrawArgs: ctx.extraArgs } } }],
    dedupeDisclosed(ctx.disclosed),
  )
}

export async function cancelRequest(dex: DexState, templateId: string, choice: string, contractId: string) {
  await dex.submit([{ ExerciseCommand: { templateId, contractId, choice, choiceArgument: {} } }])
}

// Accept or decline a token-standard transfer someone sent you.
export async function answerIncoming(dex: DexState, instructionId: string, admin: string, accept: boolean) {
  const action = accept ? 'accept' : 'reject'
  const ctx = await dex.registry(admin).transferChoice(instructionId, action)
  await dex.submit(
    [
      {
        ExerciseCommand: {
          templateId: TRANSFER_INSTRUCTION_V2,
          contractId: instructionId,
          choice: accept ? 'TransferInstruction_Accept' : 'TransferInstruction_Reject',
          choiceArgument: { actors: [dex.party!], extraArgs: ctx.extraArgs },
        },
      },
    ],
    dedupeDisclosed(ctx.disclosed),
  )
  await waitFor(() => (dex.latest().incoming.some((i) => i.cid === instructionId) ? undefined : true), 45_000)
}
