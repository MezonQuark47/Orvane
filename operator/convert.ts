// Build ConvertTicket_Swap arguments: allocate the employee's pay to the
// operator for an exchange swap into their preferred asset.

import { amountOut } from '../shared/amm.ts'
import { emptyExtraArgs } from '../shared/amulet.ts'
import type { Contract } from '../shared/ledger.ts'
import { allocationSpec, dec10, sameInstrument, spendable, type ExchangePool } from '../shared/exchange.ts'
import type { ConvertTicket } from '../shared/treasury.ts'
import { EXCHANGE_POOL_ID, type ExchangeCtx } from './exchange.ts'

export async function prepareSwapAllocation(ctx: ExchangeCtx, pool: Contract<ExchangePool>, t: ConvertTicket, operator: string) {
  const amount = +t.amount
  const p = pool.payload
  const inIsA = sameInstrument(t.from, p.instrA)
  const [resIn, resOut] = inIsA ? [+p.reserveA, +p.reserveB] : [+p.reserveB, +p.reserveA]
  const minOut = amountOut(+p.feeBps, amount, resIn, resOut) * 0.97
  const ref = `pay-${t.runId}-${Math.random().toString(36).slice(2, 7)}`
  const holdings = await spendable(ctx.ledger(), t.employee, t.from)
  const allocation = allocationSpec({ executor: operator, ref, sender: t.employee, receiver: operator, instrument: t.from, amount, legId: 'in' })
  const requestedAt = new Date(Date.now() - 5_000).toISOString()
  const inputHoldingCids = holdings.map((h) => h.contractId)
  const prepared = await ctx.reg.forInstrument(t.from, operator).allocationFactory({
    expectedAdmin: t.from.admin,
    allocation,
    requestedAt,
    inputHoldingCids,
    extraArgs: emptyExtraArgs,
  })
  return {
    disclosed: prepared.disclosed,
    args: {
      poolId: EXCHANGE_POOL_ID,
      factoryCid: prepared.factoryId,
      expectedAdmin: t.from.admin,
      allocation,
      requestedAt,
      inputHoldingCids,
      extraArgs: prepared.extraArgs,
      minOut: dec10(minOut),
    },
  }
}
