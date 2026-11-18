// Token-standard exchange on LocalNet: a USDx / Canton Coin pool whose
// trades settle through CIP-56 allocations.

import { LedgerError, type JsonLedger, type Transaction } from '../shared/ledger.ts'
import { amountOut } from '../shared/amm.ts'
import { ALLOCATION_FACTORY_V1, ALLOCATION_V1, Scan, emptyExtraArgs, holdingsOf, tapAmulet, type DisclosedContract, type InstrumentId } from '../shared/amulet.ts'
import {
  ORVANE_RULES,
  X,
  allocationSpec,
  dec10,
  floorAmount,
  registries,
  sameInstrument,
  spendable,
  type ExchangePool,
  type ExchangeSwapRequest,
  type Registries,
} from '../shared/exchange.ts'
import { TR, consentCommand, type ConvertTicket, type PayeeConsent } from '../shared/treasury.ts'
import { prepareSwapAllocation } from './convert.ts'

export const EXCHANGE_POOL_ID = 'USDx-CC'

export interface ExchangeParties {
  operator: string
  usdIssuer: string
  traders: string[]
}

export interface ExchangeCtx {
  ledger: () => JsonLedger
  log: (...args: unknown[]) => void
  scan: Scan
  amulet: InstrumentId
  usdx: InstrumentId
  reg: Registries
}

export async function exchangeContext(ledger: () => JsonLedger, log: ExchangeCtx['log'], p: ExchangeParties): Promise<ExchangeCtx> {
  const scan = new Scan()
  const dso = await scan.dso()
  return {
    ledger,
    log,
    scan,
    amulet: { admin: dso, id: 'Amulet' },
    usdx: { admin: p.usdIssuer, id: 'USDx' },
    reg: registries(ledger(), scan, dso),
  }
}

const sum = (xs: Array<{ view: { amount: string } }>) => xs.reduce((s, h) => s + Number(h.view.amount), 0)

async function tapUpTo(ctx: ExchangeCtx, party: string, target: number) {
  const have = sum(await spendable(ctx.ledger(), party, ctx.amulet))
  let missing = target - have
  while (missing > 1) {
    const chunk = Math.min(missing, 250_000)
    await tapAmulet(ctx.ledger(), ctx.scan, party, chunk)
    missing -= chunk
  }
}

async function rules(ctx: ExchangeCtx, p: ExchangeParties) {
  const found = (await ctx.ledger().query<{ admin: string; users: string[] }>(p.usdIssuer, [ORVANE_RULES])).find(
    (r) => r.payload.admin === p.usdIssuer,
  )
  if (found) return found.contractId
  ctx.log('opening the Orvane USDx registry')
  const tx = await ctx.ledger().submit([p.usdIssuer], [
    { CreateCommand: { templateId: ORVANE_RULES, createArguments: { admin: p.usdIssuer, instruments: ['USDx'], users: [p.operator, ...p.traders] } } },
  ])
  return tx.events.map((e) => e.CreatedEvent).find((e) => e)!.contractId
}

async function mintUsdx(ctx: ExchangeCtx, p: ExchangeParties, rulesCid: string, owner: string, amount: number) {
  await ctx.ledger().submit([p.usdIssuer], [
    {
      ExerciseCommand: {
        templateId: ORVANE_RULES,
        contractId: rulesCid,
        choice: 'OrvaneRules_Mint',
        choiceArgument: { instrument: 'USDx', owner, amount: dec10(amount) },
      },
    },
  ])
}

export async function findExchangePool(ctx: ExchangeCtx, operator: string) {
  const pools = await ctx.ledger().query<ExchangePool>(operator, [X.ExchangePool])
  return pools.find((x) => x.payload.poolId === EXCHANGE_POOL_ID)
}

// Seed the pool at Canton Coin's LocalNet reference price (0.005 USD/CC)
// and give every demo participant real CC and USDx to trade with.
export async function bootstrapExchange(ctx: ExchangeCtx, p: ExchangeParties) {
  const rulesCid = await rules(ctx, p)
  if (!(await findExchangePool(ctx, p.operator))) {
    ctx.log('seeding the USDx / Canton Coin pool with real CC')
    await tapUpTo(ctx, p.operator, 10_000_000)
    await mintUsdx(ctx, p, rulesCid, p.operator, 50_000)
    await ctx.ledger().submit([p.operator], [
      {
        CreateCommand: {
          templateId: X.ExchangePool,
          createArguments: {
            operator: p.operator,
            poolId: EXCHANGE_POOL_ID,
            instrA: ctx.usdx,
            instrB: ctx.amulet,
            reserveA: dec10(50_000),
            reserveB: dec10(10_000_000),
            feeBps: dec10(30),
            members: p.traders,
          },
        },
      },
    ])
  }
  for (const t of p.traders) {
    const usd = await spendable(ctx.ledger(), t, ctx.usdx)
    if (!usd.length) await mintUsdx(ctx, p, rulesCid, t, 2_000)
    await tapUpTo(ctx, t, 200_000)
  }
}

export async function fundTrader(ctx: ExchangeCtx, p: ExchangeParties, who: string) {
  const rulesCid = await rules(ctx, p)
  await mintUsdx(ctx, p, rulesCid, who, 500)
  await tapAmulet(ctx.ledger(), ctx.scan, who, 100_000)
}

// ---------- settlement ----------

const dedupe = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, d])).values()]

function exerciseResult(tx: Transaction, choice: string): unknown {
  for (const e of tx.events as Array<Record<string, { choice?: string; exerciseResult?: unknown }>>) {
    if (e.ExercisedEvent?.choice === choice) return e.ExercisedEvent.exerciseResult
  }
  return undefined
}

const failed = new Set<string>()

export async function settleExchangeOnce(ctx: ExchangeCtx, operator: string) {
  const ledger = ctx.ledger()
  const requests = await ledger.query<ExchangeSwapRequest>(operator, [X.ExchangeSwapRequest])
  for (const req of requests) {
    if (failed.has(req.contractId)) continue
    const pool = await findExchangePool(ctx, operator)
    if (!pool) return
    const r = req.payload
    const p = pool.payload
    const inIsA = sameInstrument(r.inputInstrument, p.instrA)
    const outInstr = inIsA ? p.instrB : p.instrA
    const [resIn, resOut] = inIsA ? [+p.reserveA, +p.reserveB] : [+p.reserveB, +p.reserveA]
    const out = floorAmount(amountOut(+p.feeBps, +r.amountIn, resIn, resOut))
    const inReg = ctx.reg.forInstrument(r.inputInstrument, operator)

    const reject = async (reason: string) => {
      const cancel = await inReg.allocationArgs(r.inputAllocationCid, 'cancel')
      await ledger.submit(
        [operator],
        [
          {
            ExerciseCommand: {
              templateId: X.ExchangeSwapRequest,
              contractId: req.contractId,
              choice: 'ExchangeSwapRequest_Reject',
              choiceArgument: { reason, cancelArgs: cancel.extraArgs },
            },
          },
        ],
        [],
        cancel.disclosed,
      )
      ctx.log(`rejected swap ${r.settlementRef}: ${reason}`)
    }

    let outAlloc: string | undefined
    try {
      if (out < +r.minOut || out <= 0) {
        await reject('price moved past the trader\'s minimum')
        continue
      }
      // 1. allocate the output from the pool's reserves
      const outReg = ctx.reg.forInstrument(outInstr, operator)
      const reserves = await spendable(ledger, operator, outInstr)
      const allocation = allocationSpec({
        executor: operator,
        ref: r.settlementRef,
        sender: operator,
        receiver: r.trader,
        instrument: outInstr,
        amount: out,
        legId: 'out',
      })
      const requestedAt = new Date(Date.now() - 5_000).toISOString()
      const args = { expectedAdmin: outInstr.admin, allocation, requestedAt, inputHoldingCids: reserves.map((h) => h.contractId), extraArgs: emptyExtraArgs }
      const factory = await outReg.allocationFactory(args)
      const allocTx = await ledger.submit(
        [operator],
        [
          {
            ExerciseCommand: {
              templateId: ALLOCATION_FACTORY_V1,
              contractId: factory.factoryId,
              choice: 'AllocationFactory_Allocate',
              choiceArgument: { ...args, extraArgs: factory.extraArgs },
            },
          },
        ],
        [],
        factory.disclosed,
      )
      const res = exerciseResult(allocTx, 'AllocationFactory_Allocate') as { output: { tag: string; value: { allocationCid: string } } }
      if (res?.output?.tag !== 'AllocationInstructionResult_Completed') throw new Error('output allocation not completed')
      outAlloc = res.output.value.allocationCid

      // 2. settle both legs atomically
      const [inArgs, outArgs] = await Promise.all([
        inReg.allocationArgs(r.inputAllocationCid, 'execute-transfer'),
        outReg.allocationArgs(outAlloc!, 'execute-transfer'),
      ])
      await ledger.submit(
        [operator],
        [
          {
            ExerciseCommand: {
              templateId: X.ExchangeSwapRequest,
              contractId: req.contractId,
              choice: 'ExchangeSwapRequest_Settle',
              choiceArgument: {
                poolCid: pool.contractId,
                outputAllocationCid: outAlloc,
                inputExtraArgs: inArgs.extraArgs,
                outputExtraArgs: outArgs.extraArgs,
              },
            },
          },
        ],
        [],
        dedupe([...inArgs.disclosed, ...outArgs.disclosed]),
      )
      ctx.log(`settled ${r.amountIn.replace(/\.?0+$/, '')} ${r.inputInstrument.id} -> ${out} ${outInstr.id} via token-standard allocations`)
    } catch (err) {
      const reason = err instanceof LedgerError ? err.message : err instanceof Error ? err.message : String(err)
      ctx.log(`could not settle ${r.settlementRef}: ${reason}`)
      if (outAlloc) {
        // release the reserve we locked for this trade
        try {
          const w = await ctx.reg.forInstrument(outInstr, operator).allocationArgs(outAlloc, 'withdraw')
          await ledger.submit([operator], [{ ExerciseCommand: { templateId: ALLOCATION_V1, contractId: outAlloc, choice: 'Allocation_Withdraw', choiceArgument: { extraArgs: w.extraArgs } } }], [], w.disclosed)
        } catch (e) {
          ctx.log('  could not release output allocation', e instanceof Error ? e.message : e)
        }
      }
      try {
        await reject(reason.slice(0, 160))
      } catch (e) {
        failed.add(req.contractId)
        ctx.log('  reject failed too', e instanceof Error ? e.message : e)
      }
    }
  }
}

export { holdingsOf }

// ---------- token-standard payroll ----------


export interface PayrollParties {
  operator: string
  usdIssuer: string
  employer: string
  employees: Array<{ party: string; wantsCC: boolean }>
}

// Employees sign their payee consents once; the employer gets a USDx treasury.
export async function bootstrapPayroll(ctx: ExchangeCtx, p: PayrollParties) {
  const ledger = ctx.ledger()
  const consents = await ledger.query<PayeeConsent>(p.employer, [TR.PayeeConsent])
  for (const e of p.employees) {
    if (consents.some((c) => c.payload.employee === e.party)) continue
    await ledger.submit([e.party], [consentCommand(e.party, p.employer, p.operator, e.wantsCC ? ctx.amulet : ctx.usdx)])
  }
  const treasury = await spendable(ledger, p.employer, ctx.usdx)
  if (treasury.reduce((s, h) => s + +h.view.amount, 0) < 15_000) {
    const rulesCid = (await ledger.query<{ admin: string }>(p.usdIssuer, [ORVANE_RULES])).find((r) => r.payload.admin === p.usdIssuer)!.contractId
    await mintUsdx(ctx, { operator: p.operator, usdIssuer: p.usdIssuer, traders: [] }, rulesCid, p.employer, 25_000)
  }
}

// Convert paid salaries for employees who asked for another asset. The swap
// itself is then settled by settleExchangeOnce like any other trade.
export async function convertPayOnce(ctx: ExchangeCtx, operator: string) {
  const ledger = ctx.ledger()
  const tickets = await ledger.query<ConvertTicket>(operator, [TR.ConvertTicket])
  for (const t of tickets) {
    if (failed.has(t.contractId)) continue
    const pool = await findExchangePool(ctx, operator)
    if (!pool) return
    try {
      const prep = await prepareSwapAllocation(ctx, pool, t.payload, operator)
      await ledger.submit(
        [operator],
        [{ ExerciseCommand: { templateId: TR.ConvertTicket, contractId: t.contractId, choice: 'ConvertTicket_Swap', choiceArgument: prep.args } }],
        [t.payload.employee],
        prep.disclosed,
      )
      ctx.log(`filed salary conversion ${t.payload.amount.replace(/\.?0+$/, '')} ${t.payload.from.id} -> ${t.payload.to.id}`)
    } catch (err) {
      failed.add(t.contractId)
      ctx.log('salary conversion failed', err instanceof Error ? err.message : err)
    }
  }
}
