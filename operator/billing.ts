// Token-standard invoices and wage advances: demo seeding and operator settlement.

import { LedgerError, type Contract } from '../shared/ledger.ts'
import type { DisclosedContract } from '../shared/amulet.ts'
import { X, dec10 } from '../shared/exchange.ts'
import { B, issueInvoiceCn, type AdvanceLineCn, type AdvanceRequestCn, type InvoiceConversionCn, type InvoiceCn } from '../shared/billing.ts'
import { CREDIT_MARKET_ID, allocateFromOperator, findCreditMarket, withdrawAllocation } from './credit.ts'
import { findExchangePool, type ExchangeCtx } from './exchange.ts'

const errText = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e))
const dedupe = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, d])).values()]

export async function bootstrapBilling(ctx: ExchangeCtx, p: { operator: string; supplier: string; buyer: string; employees: Array<{ party: string; limit: number }> }) {
  const ledger = ctx.ledger()
  const invoices = await ledger.query<InvoiceCn>(p.buyer, [B.InvoiceCn, B.PaidInvoiceCn])
  if (!invoices.length) {
    const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
    for (const [no, memo, amount, days] of [
      ['NOVA-2041', 'Warehouse racking, phase 2', 12_000, 21],
      ['NOVA-2042', 'Forklift maintenance, November', 1_850, 9],
    ] as const) {
      await ledger.submit([p.supplier], [issueInvoiceCn(p.supplier, p.buyer, { invoiceNo: no, memo, amount, instrument: ctx.usdx, dueDate: due(days) })])
    }
    ctx.log('Nova issued two token-standard invoices to Acme')
  }
  const lines = await ledger.query<AdvanceLineCn>(p.buyer, [B.AdvanceLineCn])
  for (const e of p.employees) {
    if (lines.some((l) => l.payload.employee === e.party)) continue
    await ledger.submit([p.buyer], [
      {
        CreateCommand: {
          templateId: B.AdvanceLineCn,
          createArguments: { employer: p.buyer, employee: e.party, operator: p.operator, marketId: CREDIT_MARKET_ID, limit: dec10(e.limit), feeBps: dec10(100), drawn: dec10(0) },
        },
      },
    ])
  }
}

const failed = new Set<string>()

export async function settleBillingOnce(ctx: ExchangeCtx, operator: string) {
  const ledger = ctx.ledger()
  const rows = await ledger.query<unknown>(operator, [B.InvoiceConversionCn, B.AdvanceRequestCn])
  for (const row of rows) {
    if (failed.has(row.contractId)) continue
    const kind = row.templateId.split(':').pop()!
    try {
      if (kind === 'InvoiceConversionCn') await settleConversion(ctx, operator, row as Contract<InvoiceConversionCn>)
      else await settleAdvance(ctx, operator, row as Contract<AdvanceRequestCn>)
    } catch (e) {
      failed.add(row.contractId)
      ctx.log(`billing: could not settle ${kind}: ${errText(e)}`)
    }
  }
}

async function settleConversion(ctx: ExchangeCtx, operator: string, c: Contract<InvoiceConversionCn>) {
  const ledger = ctx.ledger()
  const r = c.payload
  const inReg = ctx.reg.forInstrument(r.inputInstrument, operator)
  const reject = async (reason: string) => {
    const x = await inReg.allocationArgs(r.inputAllocationCid, 'cancel')
    await ledger.submit([operator], [{ ExerciseCommand: { templateId: B.InvoiceConversionCn, contractId: c.contractId, choice: 'InvoiceConversionCn_Reject', choiceArgument: { reason, cancelArgs: x.extraArgs } } }], [], x.disclosed)
    ctx.log(`billing: conversion for ${r.terms.invoiceNo} rejected (${reason}); invoice reopened`)
  }
  const pool = await findExchangePool(ctx, operator)
  if (!pool) throw new Error('no exchange pool')
  let out: string | undefined
  try {
    out = await allocateFromOperator(ctx, operator, r.terms.instrument, r.supplier, +r.terms.amount, r.ref)
    const [ia, oa] = await Promise.all([inReg.allocationArgs(r.inputAllocationCid, 'execute-transfer'), ctx.reg.forInstrument(r.terms.instrument, operator).allocationArgs(out!, 'execute-transfer')])
    await ledger.submit(
      [operator],
      [
        {
          ExerciseCommand: {
            templateId: B.InvoiceConversionCn,
            contractId: c.contractId,
            choice: 'InvoiceConversionCn_Settle',
            choiceArgument: { poolCid: pool.contractId, outputAllocationCid: out, inputExtraArgs: ia.extraArgs, outputExtraArgs: oa.extraArgs },
          },
        },
      ],
      [],
      dedupe([...ia.disclosed, ...oa.disclosed]),
    )
    ctx.log(`billing: ${r.terms.invoiceNo} paid in ${r.inputInstrument.id}, supplier received ${(+r.terms.amount).toFixed(2)} ${r.terms.instrument.id}`)
  } catch (e) {
    if (out) await withdrawAllocation(ctx, operator, r.terms.instrument, out)
    await reject(errText(e).slice(0, 160))
  }
}

async function settleAdvance(ctx: ExchangeCtx, operator: string, req: Contract<AdvanceRequestCn>) {
  const ledger = ctx.ledger()
  const market = await findCreditMarket(ctx, operator)
  if (!market) throw new Error('no credit market')
  const r = req.payload
  let payout: string | undefined
  try {
    payout = await allocateFromOperator(ctx, operator, market.payload.asset, r.employee, +r.amount, `adv-${req.contractId.slice(2, 10)}`)
    const a = await ctx.reg.forInstrument(market.payload.asset, operator).allocationArgs(payout, 'execute-transfer')
    await ledger.submit(
      [operator],
      [{ ExerciseCommand: { templateId: B.AdvanceRequestCn, contractId: req.contractId, choice: 'AdvanceRequestCn_Settle', choiceArgument: { marketCid: market.contractId, payoutAllocationCid: payout, extraArgs: a.extraArgs } } }],
      [],
      a.disclosed,
    )
    ctx.log(`billing: wage advance of ${(+r.amount).toFixed(2)} USDx paid`)
  } catch (e) {
    ctx.log(`billing: advance rejected: ${errText(e)}`)
    await ledger.submit([operator], [{ ExerciseCommand: { templateId: B.AdvanceRequestCn, contractId: req.contractId, choice: 'AdvanceRequestCn_Reject', choiceArgument: { reason: errText(e).slice(0, 160) } } }])
    if (payout) await withdrawAllocation(ctx, operator, market.payload.asset, payout)
  }
}

export { X }
