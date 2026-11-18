// Canton Coin (Amulet) and token-standard registry access via Scan.
//
// Amulet's on-ledger choices need contracts the caller does not hold
// (AmuletRules, the open mining round, ...). Scan and the registry API hand
// those out as "disclosed contracts" plus a "choice context", which we pass
// through to the Ledger API unchanged.

import type { DamlCommand, JsonLedger, Transaction } from './ledger.ts'

export interface DisclosedContract {
  templateId: string
  contractId: string
  createdEventBlob: string
  synchronizerId: string
}

export interface ChoiceContext {
  choiceContextData: unknown
  disclosedContracts: DisclosedContract[]
}

interface ScanContract {
  template_id: string
  contract_id: string
  payload: Record<string, unknown>
  created_event_blob: string
}

const toDisclosed = (c: ScanContract, synchronizerId: string): DisclosedContract => ({
  templateId: c.template_id,
  contractId: c.contract_id,
  createdEventBlob: c.created_event_blob,
  synchronizerId,
})

export const HOLDING_V1 = '#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding'
export const ALLOCATION_V1 = '#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation'
export const TRANSFER_FACTORY_V1 = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory'
export const TRANSFER_INSTRUCTION_V1 = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction'
export const ALLOCATION_FACTORY_V1 = '#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory'

export interface InstrumentId {
  admin: string
  id: string
}

export interface HoldingView {
  owner: string
  instrumentId: InstrumentId
  amount: string
  lock: unknown | null
  meta: { values: Record<string, string> }
}

export class Scan {
  readonly baseUrl: string
  constructor(baseUrl = 'http://scan.localhost:4000') {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`scan ${path} ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as T
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    const text = await res.text()
    if (!res.ok) throw new Error(`scan ${path} ${res.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as T
  }

  async dso(): Promise<string> {
    return (await this.get<{ dso_party_id: string }>('/api/scan/v0/dso-party-id')).dso_party_id
  }

  async amuletInstrument(): Promise<InstrumentId> {
    return { admin: await this.dso(), id: 'Amulet' }
  }

  async amuletRules(): Promise<{ contract: ScanContract; disclosed: DisclosedContract }> {
    const r = await this.post<{ amulet_rules_update: { contract: ScanContract; domain_id: string } }>('/api/scan/v0/amulet-rules', {})
    const u = r.amulet_rules_update
    return { contract: u.contract, disclosed: toDisclosed(u.contract, u.domain_id) }
  }

  // The newest round that is already open.
  async openRound(): Promise<{ contract: ScanContract; disclosed: DisclosedContract }> {
    const r = await this.post<{ open_mining_rounds: Record<string, { contract: ScanContract; domain_id: string }> }>(
      '/api/scan/v0/open-and-issuing-mining-rounds',
      { cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] },
    )
    const now = Date.now()
    const open = Object.values(r.open_mining_rounds)
      .filter((x) => Date.parse(String(x.contract.payload.opensAt)) <= now)
      .sort((a, b) => Number((b.contract.payload.round as { number: string }).number) - Number((a.contract.payload.round as { number: string }).number))
    const pick = open[0]
    if (!pick) throw new Error('no open mining round yet')
    return { contract: pick.contract, disclosed: toDisclosed(pick.contract, pick.domain_id) }
  }

  // ---- token-standard registry API ----

  transferFactory(choiceArguments: unknown) {
    return this.post<{ factoryId: string; transferKind: string; choiceContext: ChoiceContext }>(
      '/registry/transfer-instruction/v1/transfer-factory',
      { choiceArguments, excludeDebugFields: true },
    )
  }

  allocationFactory(choiceArguments: unknown) {
    return this.post<{ factoryId: string; choiceContext: ChoiceContext }>('/registry/allocation-instruction/v1/allocation-factory', {
      choiceArguments,
      excludeDebugFields: true,
    })
  }

  transferInstructionContext(instructionId: string, action: 'accept' | 'reject' | 'withdraw') {
    return this.post<ChoiceContext>(`/registry/transfer-instruction/v1/${encodeURIComponent(instructionId)}/choice-contexts/${action}`, {
      meta: {},
      excludeDebugFields: true,
    })
  }

  allocationContext(allocationId: string, action: 'execute-transfer' | 'withdraw' | 'cancel') {
    return this.post<ChoiceContext>(`/registry/allocations/v1/${encodeURIComponent(allocationId)}/choice-contexts/${action}`, {
      meta: {},
      excludeDebugFields: true,
    })
  }
}

// Mint test Canton Coin on LocalNet / DevNet (AmuletRules_DevNet_Tap).
export async function tapAmulet(ledger: JsonLedger, scan: Scan, receiver: string, amount: number): Promise<Transaction> {
  const [rules, round] = await Promise.all([scan.amuletRules(), scan.openRound()])
  const cmd: DamlCommand = {
    ExerciseCommand: {
      templateId: rules.contract.template_id,
      contractId: rules.contract.contract_id,
      choice: 'AmuletRules_DevNet_Tap',
      choiceArgument: { receiver, amount: amount.toFixed(10), openRound: round.contract.contract_id },
    },
  }
  return ledger.submit([receiver], [cmd], [], [rules.disclosed, round.disclosed])
}

// All token-standard holdings of `party` (any registry), via the Holding interface.
export async function holdingsOf(ledger: JsonLedger, party: string) {
  const rows = await ledger.queryInterface<HoldingView>(party, HOLDING_V1)
  return rows.filter((h) => h.view.owner === party)
}

export const emptyExtraArgs = { context: { values: {} }, meta: { values: {} } }

export const extraArgsFrom = (ctx: ChoiceContext) => ({ context: ctx.choiceContextData, meta: { values: {} } })
