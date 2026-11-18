// Token-standard payroll (Orvane.Treasury): template ids and command builders.

import type { DamlCommand } from './ledger.ts'
import { emptyExtraArgs, type InstrumentId } from './amulet.ts'
import { dec10, type Registries } from './exchange.ts'

const PKG = '#orvane-treasury'
export const TR = {
  PayeeConsent: `${PKG}:Orvane.Treasury:PayeeConsent`,
  PayslipCn: `${PKG}:Orvane.Treasury:PayslipCn`,
  PayrollAttestationCn: `${PKG}:Orvane.Treasury:PayrollAttestationCn`,
  ConvertTicket: `${PKG}:Orvane.Treasury:ConvertTicket`,
  PayrollOrderCn: `${PKG}:Orvane.Treasury:PayrollOrderCn`,
  PayrollBatch: `${PKG}:Orvane.Treasury:PayrollBatch`,
} as const

export interface PayeeConsent {
  employee: string
  employer: string
  operator: string
  receive: InstrumentId
}

export interface PayslipCn {
  employer: string
  employee: string
  runId: string
  period: string
  paid: string
  instrument: InstrumentId
  convertTo: InstrumentId | null
}

export interface PayrollAttestationCn {
  employer: string
  runId: string
  period: string
  headcount: string | number
  total: string
  instrument: InstrumentId
}

export interface ConvertTicket {
  employee: string
  operator: string
  runId: string
  from: InstrumentId
  to: InstrumentId
  amount: string
}

export interface PayrollBatch {
  employer: string
  runId: string
  period: string
  instrument: InstrumentId
  locked: Array<{ employee: string; amount: string; allocationCid: string }>
}

export const consentCommand = (employee: string, employer: string, operator: string, receive: InstrumentId, existing?: string): DamlCommand =>
  existing
    ? { ExerciseCommand: { templateId: TR.PayeeConsent, contractId: existing, choice: 'PayeeConsent_Change', choiceArgument: { newReceive: receive } } }
    : { CreateCommand: { templateId: TR.PayeeConsent, createArguments: { employee, employer, operator, receive } } }

// Step 1: lock every line as an allocation, one signature.
export async function preparePayrollLock(args: {
  reg: Registries
  employer: string
  auditors: string[]
  runId: string
  period: string
  instrument: InstrumentId
  inputHoldingCids: string[]
  lines: Array<{ employee: string; amount: number }>
}) {
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const registry = args.reg.forInstrument(args.instrument, args.employer)
  const requestedAt = iso(now - 5_000)
  const prepared = await registry.allocationFactory({
    expectedAdmin: args.instrument.admin,
    allocation: {
      settlement: {
        executor: args.employer,
        settlementRef: { id: args.runId, cid: null },
        requestedAt,
        allocateBefore: iso(now + 10 * 60_000),
        settleBefore: iso(now + 3 * 24 * 3600_000),
        meta: { values: {} },
      },
      transferLegId: 'line-0',
      transferLeg: {
        sender: args.employer,
        receiver: args.lines[0].employee,
        amount: dec10(args.lines[0].amount),
        instrumentId: args.instrument,
        meta: { values: {} },
      },
    },
    requestedAt,
    inputHoldingCids: args.inputHoldingCids,
    extraArgs: emptyExtraArgs,
  })
  const command: DamlCommand = {
    CreateAndExerciseCommand: {
      templateId: TR.PayrollOrderCn,
      createArguments: {
        employer: args.employer,
        auditors: args.auditors,
        runId: args.runId,
        period: args.period,
        factoryCid: prepared.factoryId,
        instrument: args.instrument,
        inputHoldingCids: args.inputHoldingCids,
        extraArgs: prepared.extraArgs,
        requestedAt,
        allocateBefore: iso(now + 10 * 60_000),
        settleBefore: iso(now + 3 * 24 * 3600_000),
        lines: args.lines.map((l) => ({ employee: l.employee, amount: dec10(l.amount) })),
      },
      choice: 'PayrollOrderCn_Lock',
      choiceArgument: {},
    },
  }
  return { command, disclosed: prepared.disclosed }
}

// Step 2: release every locked line, atomically.
export async function preparePayrollRelease(args: {
  reg: Registries
  employer: string
  batchCid: string
  batch: PayrollBatch
  consents: Map<string, string> // employee -> PayeeConsent cid
}) {
  const registry = args.reg.forInstrument(args.batch.instrument, args.employer)
  const contexts = await Promise.all(args.batch.locked.map((l) => registry.allocationArgs(l.allocationCid, 'execute-transfer')))
  const releases = args.batch.locked.map((l, i) => {
    const consentCid = args.consents.get(l.employee)
    if (!consentCid) throw new Error(`no payee consent for ${l.employee.split('::')[0]}`)
    return { consentCid, extraArgs: contexts[i].extraArgs }
  })
  const command: DamlCommand = {
    ExerciseCommand: { templateId: TR.PayrollBatch, contractId: args.batchCid, choice: 'PayrollBatch_Release', choiceArgument: { releases } },
  }
  const disclosed = [...new Map(contexts.flatMap((c) => c.disclosed).map((d) => [d.contractId, d])).values()]
  return { command, disclosed }
}
