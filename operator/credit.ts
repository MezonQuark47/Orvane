// Token-standard credit market on LocalNet: USDx loans against real Canton
// Coin, every movement settled as a CIP-56 allocation (DvP).

import { LedgerError, type Contract, type Transaction } from '../shared/ledger.ts'
import { ALLOCATION_FACTORY_V1, ALLOCATION_V1, TRANSFER_FACTORY_V1, emptyExtraArgs, type DisclosedContract, type InstrumentId } from '../shared/amulet.ts'
import { ORVANE_RULES, allocationSpec, dec10, floorAmount, spendable, type ExchangePool } from '../shared/exchange.ts'
import {
  CR,
  newRef,
  prepareAllocationArgs,
  supplyOrder,
  type CreditBorrowRequest,
  type CreditLoan,
  type CreditMarket,
  type CreditPosition,
  type CreditRepayRequest,
  type CreditSupplyRequest,
  type CreditSurplus,
  type CreditWithdrawRequest,
} from '../shared/credit.ts'
import { healthFactor, owedAt } from '../shared/lending.ts'
import { EXCHANGE_POOL_ID, findExchangePool, type ExchangeCtx } from './exchange.ts'

export const CREDIT_MARKET_ID = 'USDx-credit-CC'
const DEMO_YEAR_SECONDS = 3600

const dedupe = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, d])).values()]
const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))

function exerciseResult(tx: Transaction, choice: string): unknown {
  for (const e of tx.events as Array<Record<string, { choice?: string; exerciseResult?: unknown }>>) {
    if (e.ExercisedEvent?.choice === choice) return e.ExercisedEvent.exerciseResult
  }
  return undefined
}

export async function findCreditMarket(ctx: ExchangeCtx, operator: string) {
  const ms = await ctx.ledger().query<CreditMarket>(operator, [CR.CreditMarket])
  return ms.find((m) => m.payload.marketId === CREDIT_MARKET_ID)
}

// Allocate from the operator's holdings to `receiver` for settlement `ref`.
export async function allocateFromOperator(ctx: ExchangeCtx, operator: string, instrument: InstrumentId, receiver: string, amount: number, ref: string) {
  const ledger = ctx.ledger()
  const reg = ctx.reg.forInstrument(instrument, operator)
  const reserves = await spendable(ledger, operator, instrument)
  const allocation = allocationSpec({ executor: operator, ref, sender: operator, receiver, instrument, amount, legId: 'leg' })
  const requestedAt = new Date(Date.now() - 5_000).toISOString()
  const args = { expectedAdmin: instrument.admin, allocation, requestedAt, inputHoldingCids: reserves.map((h) => h.contractId), extraArgs: emptyExtraArgs }
  const f = await reg.allocationFactory(args)
  const tx = await ledger.submit(
    [operator],
    [{ ExerciseCommand: { templateId: ALLOCATION_FACTORY_V1, contractId: f.factoryId, choice: 'AllocationFactory_Allocate', choiceArgument: { ...args, extraArgs: f.extraArgs } } }],
    [],
    f.disclosed,
  )
  const res = exerciseResult(tx, 'AllocationFactory_Allocate') as { output: { tag: string; value: { allocationCid: string } } }
  if (res?.output?.tag !== 'AllocationInstructionResult_Completed') throw new Error('operator allocation not completed')
  return res.output.value.allocationCid
}

export async function withdrawAllocation(ctx: ExchangeCtx, operator: string, instrument: InstrumentId, cid: string) {
  try {
    const w = await ctx.reg.forInstrument(instrument, operator).allocationArgs(cid, 'withdraw')
    await ctx.ledger().submit([operator], [{ ExerciseCommand: { templateId: ALLOCATION_V1, contractId: cid, choice: 'Allocation_Withdraw', choiceArgument: { extraArgs: w.extraArgs } } }], [], w.disclosed)
  } catch (e) {
    ctx.log('  could not release operator allocation', errText(e))
  }
}

// ---------- bootstrap ----------

export async function bootstrapCredit(ctx: ExchangeCtx, p: { operator: string; usdIssuer: string; lender: string; members: string[] }) {
  const ledger = ctx.ledger()
  if (await findCreditMarket(ctx, p.operator)) return
  ctx.log('opening the USDx / Canton Coin credit market')
  const tx = await ledger.submit([p.operator], [
    {
      CreateCommand: {
        templateId: CR.CreditMarket,
        createArguments: {
          operator: p.operator,
          marketId: CREDIT_MARKET_ID,
          asset: ctx.usdx,
          collateral: ctx.amulet,
          poolId: EXCHANGE_POOL_ID,
          cash: dec10(0),
          principalOut: dec10(0),
          totalShares: dec10(0),
          baseAprBps: dec10(200),
          slopeAprBps: dec10(1800),
          maxLtvBps: dec10(6000),
          liqLtvBps: dec10(8000),
          yearSeconds: String(DEMO_YEAR_SECONDS),
          badDebt: dec10(0),
          members: p.members,
        },
      },
    },
  ])
  void tx
  // Alice supplies 20,000 USDx.
  const rules = (await ledger.query<{ admin: string }>(p.usdIssuer, [ORVANE_RULES])).find((r) => r.payload.admin === p.usdIssuer)!
  await ledger.submit([p.usdIssuer], [
    { ExerciseCommand: { templateId: ORVANE_RULES, contractId: rules.contractId, choice: 'OrvaneRules_Mint', choiceArgument: { instrument: 'USDx', owner: p.lender, amount: dec10(20_000) } } },
  ])
  const prep = await prepareAllocationArgs({ ledger, reg: ctx.reg, sender: p.lender, operator: p.operator, instrument: ctx.usdx, amount: 20_000, ref: newRef('supply') })
  await ledger.submit([p.lender], [supplyOrder(p.lender, p.operator, CREDIT_MARKET_ID, prep.fields)], [], prep.disclosed)
}

// ---------- settlement ----------

const failed = new Set<string>()

export async function settleCreditOnce(ctx: ExchangeCtx, operator: string) {
  const ledger = ctx.ledger()
  const rows = await ledger.query<unknown>(operator, [CR.CreditSupplyRequest, CR.CreditWithdrawRequest, CR.CreditBorrowRequest, CR.CreditRepayRequest, CR.CreditSurplus])
  for (const row of rows) {
    if (failed.has(row.contractId)) continue
    const market = await findCreditMarket(ctx, operator)
    if (!market) return
    const kind = row.templateId.split(':').pop()!
    try {
      if (kind === 'CreditSupplyRequest') await settleSupply(ctx, operator, market, row as Contract<CreditSupplyRequest>)
      else if (kind === 'CreditWithdrawRequest') await settleWithdraw(ctx, operator, market, row as Contract<CreditWithdrawRequest>)
      else if (kind === 'CreditBorrowRequest') await settleBorrow(ctx, operator, market, row as Contract<CreditBorrowRequest>)
      else if (kind === 'CreditRepayRequest') await settleRepay(ctx, operator, market, row as Contract<CreditRepayRequest>)
      else if (kind === 'CreditSurplus') await paySurplus(ctx, operator, row as Contract<CreditSurplus>)
    } catch (err) {
      failed.add(row.contractId)
      ctx.log(`credit: could not settle ${kind}: ${errText(err)}`)
    }
  }
}

async function settleSupply(ctx: ExchangeCtx, operator: string, market: Contract<CreditMarket>, req: Contract<CreditSupplyRequest>) {
  const reg = ctx.reg.forInstrument(market.payload.asset, operator)
  const a = await reg.allocationArgs(req.payload.allocationCid, 'execute-transfer')
  await ctx.ledger().submit(
    [operator],
    [{ ExerciseCommand: { templateId: CR.CreditSupplyRequest, contractId: req.contractId, choice: 'CreditSupplyRequest_Settle', choiceArgument: { marketCid: market.contractId, extraArgs: a.extraArgs } } }],
    [],
    a.disclosed,
  )
  ctx.log(`credit: supply of ${(+req.payload.amount).toFixed(2)} USDx settled`)
}

async function settleWithdraw(ctx: ExchangeCtx, operator: string, market: Contract<CreditMarket>, req: Contract<CreditWithdrawRequest>) {
  const ledger = ctx.ledger()
  const pos = (await ledger.query<CreditPosition>(operator, [CR.CreditPosition])).find((p) => p.contractId === req.payload.positionCid)
  if (!pos) throw new Error('position no longer exists')
  const m = market.payload
  const value = floorAmount((+pos.payload.shares * (+m.cash + +m.principalOut)) / +m.totalShares)
  const ref = newRef('withdraw')
  const payout = await allocateFromOperator(ctx, operator, m.asset, req.payload.lender, value, ref)
  try {
    const a = await ctx.reg.forInstrument(m.asset, operator).allocationArgs(payout, 'execute-transfer')
    await ledger.submit(
      [operator],
      [{ ExerciseCommand: { templateId: CR.CreditWithdrawRequest, contractId: req.contractId, choice: 'CreditWithdrawRequest_Settle', choiceArgument: { marketCid: market.contractId, payoutAllocationCid: payout, ref, extraArgs: a.extraArgs } } }],
      [],
      a.disclosed,
    )
    ctx.log(`credit: withdrawal of ${value} USDx settled`)
  } catch (e) {
    await withdrawAllocation(ctx, operator, m.asset, payout)
    throw e
  }
}

async function settleBorrow(ctx: ExchangeCtx, operator: string, market: Contract<CreditMarket>, req: Contract<CreditBorrowRequest>) {
  const ledger = ctx.ledger()
  const m = market.payload
  const r = req.payload
  const collReg = ctx.reg.forInstrument(m.collateral, operator)
  const reject = async (reason: string) => {
    const c = await collReg.allocationArgs(r.collateralAllocationCid, 'cancel')
    await ledger.submit([operator], [{ ExerciseCommand: { templateId: CR.CreditBorrowRequest, contractId: req.contractId, choice: 'CreditBorrowRequest_Reject', choiceArgument: { reason, cancelArgs: c.extraArgs } } }], [], c.disclosed)
    ctx.log(`credit: borrow rejected (${reason}); collateral released`)
  }
  const pool = await findExchangePool(ctx, operator)
  if (!pool) throw new Error('no exchange pool')
  let loanAlloc: string | undefined
  try {
    loanAlloc = await allocateFromOperator(ctx, operator, m.asset, r.borrower, +r.borrowAmount, r.ref)
    const [ca, la] = await Promise.all([collReg.allocationArgs(r.collateralAllocationCid, 'execute-transfer'), ctx.reg.forInstrument(m.asset, operator).allocationArgs(loanAlloc, 'execute-transfer')])
    await ledger.submit(
      [operator],
      [
        {
          ExerciseCommand: {
            templateId: CR.CreditBorrowRequest,
            contractId: req.contractId,
            choice: 'CreditBorrowRequest_Settle',
            choiceArgument: { marketCid: market.contractId, poolCid: pool.contractId, loanAllocationCid: loanAlloc, collateralArgs: ca.extraArgs, loanArgs: la.extraArgs },
          },
        },
      ],
      [],
      dedupe([...ca.disclosed, ...la.disclosed]),
    )
    ctx.log(`credit: loan of ${(+r.borrowAmount).toFixed(2)} USDx against ${(+r.collateralAmount).toFixed(0)} CC settled`)
  } catch (e) {
    if (loanAlloc) await withdrawAllocation(ctx, operator, m.asset, loanAlloc)
    await reject(errText(e).slice(0, 160))
  }
}

async function settleRepay(ctx: ExchangeCtx, operator: string, market: Contract<CreditMarket>, req: Contract<CreditRepayRequest>) {
  const ledger = ctx.ledger()
  const m = market.payload
  const r = req.payload
  const assetReg = ctx.reg.forInstrument(m.asset, operator)
  const reject = async (reason: string) => {
    const c = await assetReg.allocationArgs(r.repayAllocationCid, 'cancel')
    await ledger.submit([operator], [{ ExerciseCommand: { templateId: CR.CreditRepayRequest, contractId: req.contractId, choice: 'CreditRepayRequest_Reject', choiceArgument: { reason, cancelArgs: c.extraArgs } } }], [], c.disclosed)
    ctx.log(`credit: repayment rejected (${reason}); funds released`)
  }
  const loan = (await ledger.query<CreditLoan>(operator, [CR.CreditLoan])).find((l) => l.contractId === r.loanCid)
  if (!loan) return reject('loan is no longer open')
  let back: string | undefined
  try {
    back = await allocateFromOperator(ctx, operator, m.collateral, r.borrower, +loan.payload.collateralAmount, r.ref)
    const [ra, ca] = await Promise.all([assetReg.allocationArgs(r.repayAllocationCid, 'execute-transfer'), ctx.reg.forInstrument(m.collateral, operator).allocationArgs(back, 'execute-transfer')])
    await ledger.submit(
      [operator],
      [
        {
          ExerciseCommand: {
            templateId: CR.CreditRepayRequest,
            contractId: req.contractId,
            choice: 'CreditRepayRequest_Settle',
            choiceArgument: { marketCid: market.contractId, collateralAllocationCid: back, repayArgs: ra.extraArgs, collateralArgs: ca.extraArgs },
          },
        },
      ],
      [],
      dedupe([...ra.disclosed, ...ca.disclosed]),
    )
    ctx.log(`credit: loan repaid (${(+r.amount).toFixed(4)} USDx), collateral returned`)
  } catch (e) {
    if (back) await withdrawAllocation(ctx, operator, m.collateral, back)
    await reject(errText(e).slice(0, 160))
  }
}

// Pay liquidation surplus back to the borrower: an ordinary USDx transfer
// through the Orvane registry, which completes in one step.
async function paySurplus(ctx: ExchangeCtx, operator: string, s: Contract<CreditSurplus>) {
  const ledger = ctx.ledger()
  const amount = floorAmount(+s.payload.amount)
  if (amount > 0) {
    const holdings = await spendable(ledger, operator, ctx.usdx)
    const rules = (await ledger.query<{ admin: string }>(operator, [ORVANE_RULES])).find((r) => r.payload.admin === ctx.usdx.admin)!
    const now = Date.now()
    await ledger.submit([operator], [
      {
        ExerciseCommand: {
          templateId: TRANSFER_FACTORY_V1,
          contractId: rules.contractId,
          choice: 'TransferFactory_Transfer',
          choiceArgument: {
            expectedAdmin: ctx.usdx.admin,
            transfer: {
              sender: operator,
              receiver: s.payload.borrower,
              amount: dec10(amount),
              instrumentId: ctx.usdx,
              requestedAt: new Date(now - 5_000).toISOString(),
              executeBefore: new Date(now + 600_000).toISOString(),
              inputHoldingCids: holdings.map((h) => h.contractId),
              meta: { values: {} },
            },
            extraArgs: emptyExtraArgs,
          },
        },
      },
    ])
  }
  await ledger.submit([operator], [{ ExerciseCommand: { templateId: CR.CreditSurplus, contractId: s.contractId, choice: 'CreditSurplus_Paid', choiceArgument: {} } }])
  ctx.log(`credit: paid ${amount} USDx liquidation surplus back to the borrower`)
}

// ---------- liquidation keeper ----------

export async function liquidateCreditOnce(ctx: ExchangeCtx, operator: string) {
  const ledger = ctx.ledger()
  const loans = await ledger.query<CreditLoan>(operator, [CR.CreditLoan])
  if (!loans.length) return
  for (const loan of loans) {
    const [market, pool] = await Promise.all([findCreditMarket(ctx, operator), findExchangePool(ctx, operator)])
    if (!market || !pool) return
    const m = market.payload
    const price = priceOf(pool.payload, m.asset)
    const owed = owedAt(+m.yearSeconds, +loan.payload.principal, +loan.payload.aprBps, loan.payload.openedAt)
    const hf = healthFactor(+loan.payload.collateralAmount * price, +m.liqLtvBps / 10_000, owed)
    if (hf >= 0.995) continue // small margin for clock skew between us and the ledger
    try {
      await ledger.submit([operator], [{ ExerciseCommand: { templateId: CR.CreditLoan, contractId: loan.contractId, choice: 'CreditLoan_Liquidate', choiceArgument: { marketCid: market.contractId, poolCid: pool.contractId } } }])
      ctx.log(`credit: liquidated a loan (health ${hf.toFixed(3)}) by selling its CC into ${EXCHANGE_POOL_ID}`)
    } catch (e) {
      ctx.log('credit: liquidation failed', errText(e))
    }
  }
}

// USDx per CC from the exchange pool.
export function priceOf(p: ExchangePool, asset: InstrumentId) {
  const assetIsA = p.instrA.admin === asset.admin && p.instrA.id === asset.id
  return assetIsA ? +p.reserveA / +p.reserveB : +p.reserveB / +p.reserveA
}
