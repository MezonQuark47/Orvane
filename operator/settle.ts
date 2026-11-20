// The operator's settlement loop. It fills or rejects whatever traders and
// providers have filed, and retires positions whose term is over.
//
// Every submission uses a command id derived from the request it handles, so
// a retry after a crash or a timeout can never settle the same request twice.

import { LedgerError, type Contract } from '../shared/ledger.ts'
import { dedupeDisclosed } from '../shared/registry.ts'
import {
  DEX,
  allocateArgs,
  emptyExtraArgs,
  poolSettlement,
  type ChoiceArgs,
  type DepositRequest,
  type DisclosedContract,
  type InstrumentId,
  type LpPosition,
  type PoolState,
  type RenewRequest,
  type SwapRequest,
  type WithdrawRequest,
} from '../shared/dex.ts'
import type { Network } from './network.ts'

const exercise = (templateId: string, contractId: string, choice: string, choiceArgument: unknown) => ({
  ExerciseCommand: { templateId, contractId, choice, choiceArgument },
})

// The operator's clock as the contract sees it: a little in the past, so it
// is never ahead of ledger time.
const asOf = () => new Date(Date.now() - 5_000).toISOString()

const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))

// A request the contract itself turned down (a failed check, not enough
// funds, a passed deadline) will fail the same way again; anything else
// (contention, a busy participant, the network) is worth another try.
function isFinal(e: unknown): boolean {
  const text = e instanceof LedgerError ? `${e.message} ${e.body}` : errText(e)
  return /check failed|Not enough funds|deadline|INTERPRETATION_USER_ERROR|UNHANDLED_EXCEPTION|DAML_FAILURE|FAILED_PRECONDITION/i.test(text)
    && !/CONTRACT_NOT_FOUND|LOCKED_CONTRACTS|NOT_FOUND_CONTRACT/i.test(text)
}

const attempts = new Map<string, number>()
const MAX_ATTEMPTS = 5

export async function settleOnce(net: Network) {
  const { ledger, operator } = net
  await dropExpired(net)
  const rows = await ledger.query<unknown>(operator, [DEX.DepositRequest, DEX.WithdrawRequest, DEX.RenewRequest, DEX.SwapRequest])
  // liquidity first, then trades, each in the order they arrived
  const order = ['DepositRequest', 'WithdrawRequest', 'RenewRequest', 'SwapRequest']
  rows.sort((a, b) => order.indexOf(kindOf(a)) - order.indexOf(kindOf(b)) || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  for (const row of rows) {
    const kind = kindOf(row)
    const tries = attempts.get(row.contractId) ?? 0
    if (tries >= MAX_ATTEMPTS + 1) continue
    try {
      if (kind === 'DepositRequest') await addLiquidity(net, row as Contract<DepositRequest>)
      else if (kind === 'WithdrawRequest') await removeLiquidity(net, row as Contract<WithdrawRequest>)
      else if (kind === 'RenewRequest') await renew(net, row as Contract<RenewRequest>)
      else await swap(net, row as Contract<SwapRequest>)
      attempts.delete(row.contractId)
    } catch (e) {
      attempts.set(row.contractId, tries + 1)
      const final = isFinal(e) || tries + 1 >= MAX_ATTEMPTS
      net.log(`${kind}: ${final ? 'giving up' : 'will retry'}: ${errText(e).slice(0, 200)}`)
      if (!final) continue
      try {
        await reject(net, kind, row, errText(e))
      } catch (e2) {
        net.log(`  could not hand ${kind} back: ${errText(e2).slice(0, 200)}`)
      }
    }
  }
}

const kindOf = (c: Contract<unknown>) => c.templateId.split(':').pop()!

async function poolState(net: Network, poolId: string): Promise<Contract<PoolState>> {
  const states = (await net.ledger.query<PoolState>(net.operator, [DEX.PoolState])).filter((s) => s.payload.poolId === poolId)
  if (states.length !== 1) throw new Error(`expected one state for pool ${poolId}, found ${states.length}`)
  return states[0]
}

async function positions(net: Network, poolId: string): Promise<Contract<LpPosition>[]> {
  return (await net.ledger.query<LpPosition>(net.operator, [DEX.LpPosition])).filter((p) => p.payload.poolId === poolId)
}

function poolOf(net: Network, poolId: string) {
  const pool = net.pools.get(poolId)
  if (!pool) throw new Error(`check failed: unknown pool ${poolId}`)
  return pool
}

async function submit(net: Network, commandId: string, commands: unknown[], disclosed: DisclosedContract[] = []) {
  return net.ledger.submit([net.operator], commands as never, [], dedupeDisclosed(disclosed), `orvane:${commandId}`)
}

// The Daml `Registry` record for one admin, with what it needs disclosed.
async function registryArgs(net: Network, instrument: InstrumentId, poolId: string, allocations: string[]) {
  const settlement = poolSettlement(net.operator, poolId)
  const reg = net.registries.for(instrument.admin)
  const [alloc, settle] = await Promise.all([
    reg.allocationFactory(
      allocateArgs({ settlement, admin: instrument.admin, owner: net.operator, sides: [], deadline: null, funding: null, committed: false, requestedAt: new Date(asOf()), inputHoldingCids: [] }),
    ),
    reg.settlementFactory({
      settlement,
      transferLegs: [],
      allocations: allocations.map((allocationCid) => ({ allocationCid, extraTransferLegSides: [], nextIterationFunding: null })),
      actors: [net.operator],
      extraArgs: emptyExtraArgs(),
    }),
  ])
  return {
    record: { allocationFactory: alloc.factoryId, settlementFactory: settle.factoryId, allocateArgs: alloc.extraArgs, settleArgs: settle.extraArgs },
    disclosed: [...alloc.disclosed, ...settle.disclosed],
  }
}

const cancelArgs = (net: Network, admin: string, allocationId: string): Promise<ChoiceArgs> => net.registries.for(admin).allocationChoice(allocationId, 'cancel')

// ---------- handlers ----------

async function swap(net: Network, req: Contract<SwapRequest>) {
  const r = req.payload
  const pool = poolOf(net, r.poolId)
  if (Date.parse(r.deadline) <= Date.now()) throw new Error('check failed: the swap deadline passed before it could settle')
  const state = await poolState(net, r.poolId)
  const open = await positions(net, r.poolId)
  const aToB = r.instrumentIn.admin === pool.terms.instrumentA.admin && r.instrumentIn.id === pool.terms.instrumentA.id
  const inAllocs = open.map((p) => (aToB ? p.payload.allocationA : p.payload.allocationB))
  const outAllocs = open.map((p) => (aToB ? p.payload.allocationB : p.payload.allocationA))
  const [regIn, regOut] = await Promise.all([
    registryArgs(net, r.instrumentIn, r.poolId, [r.inputAllocation, ...inAllocs]),
    registryArgs(net, r.instrumentOut, r.poolId, outAllocs),
  ])
  const tx = await submit(
    net,
    `swap:${req.contractId}`,
    [
      exercise(DEX.PoolRules, pool.rulesCid, 'PoolRules_Swap', {
        stateCid: state.contractId,
        positionCids: open.map((p) => p.contractId),
        requestCid: req.contractId,
        registryIn: regIn.record,
        registryOut: regOut.record,
        asOf: asOf(),
      }),
    ],
    [...regIn.disclosed, ...regOut.disclosed],
  )
  const receipt = tx.events.map((e) => e.CreatedEvent).find((e) => e && e.templateId.endsWith(':Orvane.Dex.State:SwapReceipt'))
  const out = (receipt?.createArgument as { amountOut?: string } | undefined)?.amountOut
  net.log(`swap ${r.poolId}: ${(+r.amountIn).toFixed(4)} ${r.instrumentIn.id} -> ${out ? (+out).toFixed(4) : '?'} ${r.instrumentOut.id} across ${open.length} positions`)
}

async function addLiquidity(net: Network, req: Contract<DepositRequest>) {
  const r = req.payload
  const pool = poolOf(net, r.poolId)
  const state = await poolState(net, r.poolId)
  await submit(net, `deposit:${req.contractId}`, [
    exercise(DEX.PoolRules, pool.rulesCid, 'PoolRules_AddLiquidity', { stateCid: state.contractId, requestCid: req.contractId, asOf: asOf() }),
  ])
  net.log(`deposit ${r.poolId}: ${(+r.amountA).toFixed(4)} ${r.instrumentA.id} + ${(+r.amountB).toFixed(4)} ${r.instrumentB.id} until ${r.termEnd.slice(0, 16)}`)
}

async function findPosition(net: Network, poolId: string, provider: string, positionId: string) {
  const p = (await positions(net, poolId)).find((x) => x.payload.provider === provider && x.payload.positionId === positionId)
  if (!p) throw new Error(`check failed: no open position ${positionId} for this provider`)
  return p
}

async function removeLiquidity(net: Network, req: Contract<WithdrawRequest>) {
  const r = req.payload
  const pool = poolOf(net, r.poolId)
  const pos = await findPosition(net, r.poolId, r.provider, r.positionId)
  const state = await poolState(net, r.poolId)
  const p = pos.payload
  const [a, b] = await Promise.all([cancelArgs(net, p.instrumentA.admin, p.allocationA), cancelArgs(net, p.instrumentB.admin, p.allocationB)])
  await submit(
    net,
    `withdraw:${req.contractId}`,
    [
      exercise(DEX.PoolRules, pool.rulesCid, 'PoolRules_RemoveLiquidity', {
        stateCid: state.contractId,
        positionCid: pos.contractId,
        requestCid: req.contractId,
        cancelArgsA: a.extraArgs,
        cancelArgsB: b.extraArgs,
        asOf: asOf(),
      }),
    ],
    [...a.disclosed, ...b.disclosed],
  )
  net.log(`withdraw ${r.poolId}: position ${r.positionId} returned to its provider`)
}

async function renew(net: Network, req: Contract<RenewRequest>) {
  const r = req.payload
  const pool = poolOf(net, r.poolId)
  const pos = await findPosition(net, r.poolId, r.provider, r.positionId)
  const p = pos.payload
  const [a, b, regA, regB] = await Promise.all([
    cancelArgs(net, p.instrumentA.admin, p.allocationA),
    cancelArgs(net, p.instrumentB.admin, p.allocationB),
    registryArgs(net, p.instrumentA, r.poolId, []),
    registryArgs(net, p.instrumentB, r.poolId, []),
  ])
  await submit(
    net,
    `renew:${req.contractId}`,
    [
      exercise(DEX.PoolRules, pool.rulesCid, 'PoolRules_Renew', {
        positionCid: pos.contractId,
        requestCid: req.contractId,
        cancelArgsA: a.extraArgs,
        registryA: regA.record,
        cancelArgsB: b.extraArgs,
        registryB: regB.record,
        asOf: asOf(),
      }),
    ],
    [...a.disclosed, ...b.disclosed, ...regA.disclosed, ...regB.disclosed],
  )
  net.log(`renew ${r.poolId}: position ${r.positionId} now runs until ${r.termEnd.slice(0, 16)}`)
}

// Positions whose term is over leave the books. If the provider has not
// taken the funds back yet, the operator releases them on the way out.
async function dropExpired(net: Network) {
  for (const [poolId, pool] of net.pools) {
    const expired = (await positions(net, poolId)).filter((p) => Date.parse(p.payload.termEnd) < Date.now() - 5_000)
    for (const pos of expired) {
      const p = pos.payload
      const run = async (release: boolean) => {
        const state = await poolState(net, poolId)
        let cancel: unknown = null
        let disclosed: DisclosedContract[] = []
        if (release) {
          const [a, b] = await Promise.all([cancelArgs(net, p.instrumentA.admin, p.allocationA), cancelArgs(net, p.instrumentB.admin, p.allocationB)])
          cancel = { _1: a.extraArgs, _2: b.extraArgs }
          disclosed = [...a.disclosed, ...b.disclosed]
        }
        await submit(
          net,
          `expire:${pos.contractId}:${release ? 'release' : 'books'}`,
          [exercise(DEX.PoolRules, pool.rulesCid, 'PoolRules_DropExpired', { stateCid: state.contractId, positionCid: pos.contractId, cancelArgs: cancel, asOf: asOf() })],
          disclosed,
        )
      }
      try {
        await run(true)
        net.log(`term over ${poolId}: position ${p.positionId} released to its provider`)
      } catch {
        // the provider or the registry already returned the funds
        try {
          await run(false)
          net.log(`term over ${poolId}: position ${p.positionId} closed (funds were already back)`)
        } catch (e) {
          net.log(`term over ${poolId}: could not close ${p.positionId}: ${errText(e).slice(0, 200)}`)
        }
      }
    }
  }
}

// Hand a request back to whoever filed it, releasing anything it locked.
async function reject(net: Network, kind: string, row: Contract<unknown>, why: string) {
  // keep the contract's own words: "check failed: <what>" -> "<what>"
  const reason = (/check failed: ([^"\n]+)/.exec(why)?.[1] ?? why).slice(0, 200)
  if (kind === 'SwapRequest') {
    const r = row.payload as SwapRequest
    let cancel: ChoiceArgs | undefined
    try {
      cancel = await cancelArgs(net, r.instrumentIn.admin, r.inputAllocation)
    } catch {
      // the trader already took the allocation back
    }
    const run = (args?: ChoiceArgs) =>
      submit(net, `reject:${row.contractId}:${args ? 'release' : 'note'}`, [
        exercise(DEX.SwapRequest, row.contractId, 'SwapRequest_Reject', { reason, cancelArgs: args?.extraArgs ?? null }),
      ], args?.disclosed)
    try {
      await run(cancel)
    } catch {
      await run(undefined)
    }
    net.log(`  swap ${r.requestId} handed back: ${reason}`)
  } else if (kind === 'DepositRequest') {
    const r = row.payload as DepositRequest
    const [a, b] = await Promise.all([cancelArgs(net, r.instrumentA.admin, r.allocationA), cancelArgs(net, r.instrumentB.admin, r.allocationB)])
    await submit(
      net,
      `reject:${row.contractId}`,
      [exercise(DEX.DepositRequest, row.contractId, 'DepositRequest_Reject', { reason, cancelArgsA: a.extraArgs, cancelArgsB: b.extraArgs })],
      [...a.disclosed, ...b.disclosed],
    )
    net.log(`  deposit ${r.requestId} handed back: ${reason}`)
  }
  // Withdraw and renew requests lock nothing; the provider can cancel them.
}
