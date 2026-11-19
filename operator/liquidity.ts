// Liquidity for the token-standard pool: providers add both sides as CIP-56
// allocations and get an LP share; withdrawing pays out their part of both
// reserves. The operator only books and settles; it never sees a provider's
// position unless it is theirs to settle.

import { LedgerError, type Contract } from '../shared/ledger.ts'
import type { DisclosedContract } from '../shared/amulet.ts'
import { dec10, floorAmount, type ExchangePool } from '../shared/exchange.ts'
import { newRef } from '../shared/credit.ts'
import { LQ, type LpBook, type LpDepositRequest, type LpShare, type LpWithdrawRequest } from '../shared/liquidity.ts'
import { allocateFromOperator, withdrawAllocation } from './credit.ts'
import { EXCHANGE_POOL_ID, findExchangePool, type ExchangeCtx } from './exchange.ts'

const dedupe = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, d])).values()]
const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))

async function findBook(ctx: ExchangeCtx, operator: string) {
  const books = await ctx.ledger().query<LpBook>(operator, [LQ.LpBook])
  return books.find((b) => b.payload.poolId === EXCHANGE_POOL_ID)
}

// The pool was seeded by the operator, so the first share is the operator's.
export async function bootstrapLiquidity(ctx: ExchangeCtx, operator: string) {
  if (await findBook(ctx, operator)) return
  const pool = await findExchangePool(ctx, operator)
  if (!pool) return
  const shares = dec10(Math.sqrt(+pool.payload.reserveA * +pool.payload.reserveB))
  ctx.log(`opening the LP books for ${EXCHANGE_POOL_ID}`)
  await ctx.ledger().submit([operator], [
    { CreateCommand: { templateId: LQ.LpBook, createArguments: { operator, poolId: EXCHANGE_POOL_ID, totalShares: shares, members: pool.payload.members } } },
    { CreateCommand: { templateId: LQ.LpShare, createArguments: { operator, owner: operator, poolId: EXCHANGE_POOL_ID, shares } } },
  ])
}

const failed = new Set<string>()

export async function settleLiquidityOnce(ctx: ExchangeCtx, operator: string) {
  const rows = await ctx.ledger().query<unknown>(operator, [LQ.LpDepositRequest, LQ.LpWithdrawRequest])
  for (const row of rows) {
    if (failed.has(row.contractId)) continue
    const pool = await findExchangePool(ctx, operator)
    const book = await findBook(ctx, operator)
    if (!pool || !book) return
    const kind = row.templateId.split(':').pop()!
    try {
      if (kind === 'LpDepositRequest') await settleDeposit(ctx, operator, pool, book, row as Contract<LpDepositRequest>)
      else await settleWithdraw(ctx, operator, pool, book, row as Contract<LpWithdrawRequest>)
    } catch (err) {
      failed.add(row.contractId)
      ctx.log(`liquidity: could not settle ${kind}: ${errText(err)}`)
      // a deposit that can't settle goes straight back to its provider
      if (kind === 'LpDepositRequest') await rejectDeposit(ctx, operator, row as Contract<LpDepositRequest>, errText(err))
    }
  }
}

async function settleDeposit(ctx: ExchangeCtx, operator: string, pool: Contract<ExchangePool>, book: Contract<LpBook>, req: Contract<LpDepositRequest>) {
  const r = req.payload
  const a = await ctx.reg.forInstrument(r.instrumentA, operator).allocationArgs(r.allocationA, 'execute-transfer')
  const b = await ctx.reg.forInstrument(r.instrumentB, operator).allocationArgs(r.allocationB, 'execute-transfer')
  await ctx.ledger().submit(
    [operator],
    [
      {
        ExerciseCommand: {
          templateId: LQ.LpDepositRequest,
          contractId: req.contractId,
          choice: 'LpDepositRequest_Settle',
          choiceArgument: { poolCid: pool.contractId, bookCid: book.contractId, extraArgsA: a.extraArgs, extraArgsB: b.extraArgs },
        },
      },
    ],
    [],
    dedupe([...a.disclosed, ...b.disclosed]),
  )
  ctx.log(`liquidity: deposit of ${(+r.amountA).toFixed(2)} + ${(+r.amountB).toFixed(2)} settled`)
}

async function rejectDeposit(ctx: ExchangeCtx, operator: string, req: Contract<LpDepositRequest>, reason: string) {
  const r = req.payload
  try {
    const a = await ctx.reg.forInstrument(r.instrumentA, operator).allocationArgs(r.allocationA, 'cancel')
    const b = await ctx.reg.forInstrument(r.instrumentB, operator).allocationArgs(r.allocationB, 'cancel')
    await ctx.ledger().submit(
      [operator],
      [
        {
          ExerciseCommand: {
            templateId: LQ.LpDepositRequest,
            contractId: req.contractId,
            choice: 'LpDepositRequest_Reject',
            choiceArgument: { reason: reason.slice(0, 160), cancelArgsA: a.extraArgs, cancelArgsB: b.extraArgs },
          },
        },
      ],
      [],
      dedupe([...a.disclosed, ...b.disclosed]),
    )
    ctx.log('  deposit returned to the provider')
  } catch (e) {
    ctx.log('  could not return the deposit', errText(e))
  }
}

async function settleWithdraw(ctx: ExchangeCtx, operator: string, pool: Contract<ExchangePool>, book: Contract<LpBook>, req: Contract<LpWithdrawRequest>) {
  const ledger = ctx.ledger()
  const r = req.payload
  const share = (await ledger.query<LpShare>(operator, [LQ.LpShare])).find((s) => s.contractId === r.shareCid)
  if (!share) throw new Error('share no longer exists')
  const p = pool.payload
  // The contract checks payout <= reserve * (shares / total) in 10-decimal
  // arithmetic. Truncate the fraction the same way and keep a hair under it,
  // so float rounding can never push a payout over the line.
  const fraction = Math.floor((+share.payload.shares / +book.payload.totalShares) * 1e10) / 1e10
  const outA = floorAmount(+p.reserveA * fraction - 1e-6)
  const outB = floorAmount(+p.reserveB * fraction - 1e-6)
  if (outA < +r.minA || outB < +r.minB) throw new Error('slippage: withdrawal below minimum')
  const ref = newRef('lp-out')
  const payA = await allocateFromOperator(ctx, operator, p.instrA, r.provider, outA, ref)
  let payB: string | undefined
  try {
    payB = await allocateFromOperator(ctx, operator, p.instrB, r.provider, outB, ref)
    const a = await ctx.reg.forInstrument(p.instrA, operator).allocationArgs(payA, 'execute-transfer')
    const b = await ctx.reg.forInstrument(p.instrB, operator).allocationArgs(payB, 'execute-transfer')
    await ledger.submit(
      [operator],
      [
        {
          ExerciseCommand: {
            templateId: LQ.LpWithdrawRequest,
            contractId: req.contractId,
            choice: 'LpWithdrawRequest_Settle',
            choiceArgument: { poolCid: pool.contractId, bookCid: book.contractId, payoutA: payA, payoutB: payB, ref, extraArgsA: a.extraArgs, extraArgsB: b.extraArgs },
          },
        },
      ],
      [],
      dedupe([...a.disclosed, ...b.disclosed]),
    )
    ctx.log(`liquidity: withdrawal of ${outA} + ${outB} settled`)
  } catch (e) {
    await withdrawAllocation(ctx, operator, p.instrA, payA)
    if (payB) await withdrawAllocation(ctx, operator, p.instrB, payB)
    throw e
  }
}
