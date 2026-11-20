// Token-standard V2 registries (CIP-0112 off-ledger API).
//
// Every instrument admin runs a registry that hands out the factory contracts
// and choice context its on-ledger choices need. Canton Coin's registry is
// Scan. The official Splice test token has no server of its own, so on
// LocalNet the operator serves it from the admin's ledger view, the same way
// Splice's reference registry for that token does.

import type { JsonLedger } from './ledger.ts'
import type { AnyValue, ChoiceArgs, DisclosedContract, ExtraArgs, FactoryCall } from './dex.ts'

export type AllocationAction = 'cancel' | 'withdraw'
export type TransferAction = 'accept' | 'reject' | 'withdraw'

export interface Registry {
  readonly admin: string
  allocationFactory(choiceArguments: unknown): Promise<FactoryCall>
  settlementFactory(choiceArguments: unknown): Promise<FactoryCall>
  allocationChoice(allocationId: string, action: AllocationAction): Promise<ChoiceArgs>
  transferFactory(choiceArguments: unknown): Promise<FactoryCall>
  transferChoice(instructionId: string, action: TransferAction): Promise<ChoiceArgs>
}

interface WireContext {
  choiceContextData: { values?: Record<string, AnyValue> }
  disclosedContracts: Array<DisclosedContract & Record<string, unknown>>
}

// Keep only what the Ledger API accepts; registries may add debug fields.
export const stripDisclosed = (d: DisclosedContract): DisclosedContract => ({
  templateId: d.templateId,
  contractId: d.contractId,
  createdEventBlob: d.createdEventBlob,
  synchronizerId: d.synchronizerId,
})

export const dedupeDisclosed = (ds: DisclosedContract[]) => [...new Map(ds.map((d) => [d.contractId, stripDisclosed(d)])).values()]

const toArgs = (ctx: WireContext): ChoiceArgs => ({
  extraArgs: { context: { values: ctx.choiceContextData.values ?? {} }, meta: { values: {} } },
  disclosed: ctx.disclosedContracts.map(stripDisclosed),
})

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

// ---------- Canton Coin: Scan ----------

export class ScanRegistry implements Registry {
  readonly admin: string
  private readonly base: string
  constructor(scanUrl: string, admin: string) {
    this.base = scanUrl.replace(/\/$/, '')
    this.admin = admin
  }

  static async connect(scanUrl: string): Promise<ScanRegistry> {
    const res = await fetch(`${scanUrl.replace(/\/$/, '')}/api/scan/v0/dso-party-id`)
    if (!res.ok) throw new Error(`scan unreachable at ${scanUrl}: ${res.status}`)
    const { dso_party_id } = (await res.json()) as { dso_party_id: string }
    return new ScanRegistry(scanUrl, dso_party_id)
  }

  private async factory(path: string, choiceArguments: unknown): Promise<FactoryCall> {
    const r = await postJson<{ factoryId: string; choiceContext: WireContext }>(`${this.base}${path}`, { choiceArguments, excludeDebugFields: true })
    return { factoryId: r.factoryId, ...toArgs(r.choiceContext) }
  }

  private async choice(path: string): Promise<ChoiceArgs> {
    return toArgs(await postJson<WireContext>(`${this.base}${path}`, { meta: {}, excludeDebugFields: true }))
  }

  allocationFactory(choiceArguments: unknown) {
    return this.factory('/registry/allocation-instruction/v2/allocation-factory', choiceArguments)
  }
  settlementFactory(choiceArguments: unknown) {
    return this.factory('/registry/allocation/v2/settlement-factory', choiceArguments)
  }
  allocationChoice(id: string, action: AllocationAction) {
    return this.choice(`/registry/allocations/v2/${encodeURIComponent(id)}/choice-contexts/${action}`)
  }
  transferFactory(choiceArguments: unknown) {
    return this.factory('/registry/transfer-instruction/v2/transfer-factory', choiceArguments)
  }
  transferChoice(id: string, action: TransferAction) {
    return this.choice(`/registry/transfer-instruction/v2/${encodeURIComponent(id)}/choice-contexts/${action}`)
  }
}

// ---------- Splice test token: served from the admin's ledger view ----------

const TT = {
  TokenRules: '#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2:TokenRules',
  Token: '#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2.Holding:Token',
  Allocation: '#splice-test-token-v2:Splice.Testing.Tokens.TestTokenV2.Allocation:TokenAllocationV2',
}
export const TEST_TOKEN = TT

export class TestTokenRegistry implements Registry {
  readonly admin: string
  private readonly ledger: () => JsonLedger
  constructor(ledger: () => JsonLedger, admin: string) {
    this.ledger = ledger
    this.admin = admin
  }

  private async rules(): Promise<{ id: string; disclosed: DisclosedContract; extraArgs: ExtraArgs }> {
    const rows = await this.ledger().queryDisclosable<{ admin: string }>(this.admin, [TT.TokenRules])
    const rules = rows.find((r) => r.payload.admin === this.admin)
    if (!rules) throw new Error(`no test-token rules for ${this.admin}`)
    return {
      id: rules.contractId,
      disclosed: rules.disclosed,
      extraArgs: { context: { values: { 'testTokenV2/tokenRules': { tag: 'AV_ContractId', value: rules.contractId } } }, meta: { values: {} } },
    }
  }

  // The tokens locked in the given allocations. An executor settling or
  // cancelling an allocation cannot see them, so the registry discloses them.
  private async lockedFunds(allocationIds: string[]): Promise<DisclosedContract[]> {
    if (!allocationIds.length) return []
    const wanted = new Set(allocationIds)
    const allocations = await this.ledger().query<{ lockedTokens: Record<string, string[]> }>(this.admin, [TT.Allocation])
    const tokenIds = new Set(allocations.filter((a) => wanted.has(a.contractId)).flatMap((a) => Object.values(a.payload.lockedTokens).flat()))
    if (!tokenIds.size) return []
    const tokens = await this.ledger().queryDisclosable(this.admin, [TT.Token])
    return tokens.filter((t) => tokenIds.has(t.contractId)).map((t) => t.disclosed)
  }

  private async withRules(extra: DisclosedContract[] = []): Promise<FactoryCall> {
    const r = await this.rules()
    return { factoryId: r.id, extraArgs: r.extraArgs, disclosed: [r.disclosed, ...extra] }
  }

  allocationFactory() {
    return this.withRules()
  }

  async settlementFactory(choiceArguments: unknown) {
    const allocations = (choiceArguments as { allocations?: Array<{ allocationCid: string }> }).allocations ?? []
    return this.withRules(await this.lockedFunds(allocations.map((a) => a.allocationCid)))
  }

  // Only the executor's cancel needs the locked funds disclosed; an owner
  // withdrawing their own allocation already sees them.
  async allocationChoice(id: string, action: AllocationAction) {
    const { extraArgs, disclosed } = await this.withRules(action === 'cancel' ? await this.lockedFunds([id]) : [])
    return { extraArgs, disclosed }
  }

  transferFactory() {
    return this.withRules()
  }

  async transferChoice() {
    const { extraArgs, disclosed } = await this.withRules()
    return { extraArgs, disclosed }
  }
}

// ---------- through the operator's API (for the web app) ----------

export class HttpRegistry implements Registry {
  readonly admin: string
  private readonly base: string
  constructor(operatorUrl: string, admin: string) {
    this.base = `${operatorUrl.replace(/\/$/, '')}/api/registry/${encodeURIComponent(admin)}`
    this.admin = admin
  }
  allocationFactory(choiceArguments: unknown) {
    return postJson<FactoryCall>(`${this.base}/allocation-factory`, { choiceArguments })
  }
  settlementFactory(choiceArguments: unknown) {
    return postJson<FactoryCall>(`${this.base}/settlement-factory`, { choiceArguments })
  }
  allocationChoice(id: string, action: AllocationAction) {
    return postJson<ChoiceArgs>(`${this.base}/allocations/${encodeURIComponent(id)}/${action}`, {})
  }
  transferFactory(choiceArguments: unknown) {
    return postJson<FactoryCall>(`${this.base}/transfer-factory`, { choiceArguments })
  }
  transferChoice(id: string, action: TransferAction) {
    return postJson<ChoiceArgs>(`${this.base}/transfers/${encodeURIComponent(id)}/${action}`, {})
  }
}

// Route a request to the registry of the instrument's admin.
export class Registries {
  private readonly byAdmin = new Map<string, Registry>()
  add(r: Registry) {
    this.byAdmin.set(r.admin, r)
    return this
  }
  for(admin: string): Registry {
    const r = this.byAdmin.get(admin)
    if (!r) throw new Error(`no registry known for admin ${admin}`)
    return r
  }
  has(admin: string) {
    return this.byAdmin.has(admin)
  }
}
