// Connecting the operator to a network: the config file, the ledger clients,
// the registries, and the one-time setup of parties, packages and pools.

import { readFile } from 'node:fs/promises'
import { JsonLedger, type LedgerAuth } from '../shared/ledger.ts'
import { Registries, ScanRegistry, TestTokenRegistry, TEST_TOKEN } from '../shared/registry.ts'
import { DEX, createPoolRules, sameInstrument, seconds, type DisclosedContract, type InstrumentId, type PoolRules, type PoolTerms } from '../shared/dex.ts'

export interface NetworkConfig {
  network: string
  ledger: {
    url: string
    adminUser: string
    appUser: string
    audience: string
    /** a real validator's identity provider (OAuth 2.0 client credentials); LocalNet has none */
    oidc?: { tokenUrl: string; scope?: string }
  }
  userParticipants: string[]
  scan: string
  operatorHint: string
  testTokens: Array<{ id: string; adminHint: string; label: string }>
  instruments: Record<string, { registry: 'scan' | 'testToken'; id: string; label: string }>
  pools: Array<{
    poolId: string
    a: string
    b: string
    feeBps: number
    maxPositions: number
    minTermSeconds: number
    maxTermSeconds: number
    ratioToleranceBps: number
  }>
}

export async function loadConfig(network = process.env.ORVANE_NETWORK ?? 'localnet'): Promise<NetworkConfig> {
  const file = new URL(`../config/pairs.${network}.json`, import.meta.url)
  try {
    return JSON.parse(await readFile(file, 'utf8')) as NetworkConfig
  } catch (err) {
    throw new Error(`cannot read config/pairs.${network}.json: ${err instanceof Error ? err.message : err}`)
  }
}

// LocalNet participants accept HS256 tokens signed with a well-known dev
// secret. Real validators log in through their identity provider; the
// client's id and secret come from the environment, never from a file.
export function authFor(cfg: NetworkConfig): LedgerAuth {
  const oidc = cfg.ledger.oidc
  if (oidc) {
    const clientId = process.env.ORVANE_OIDC_CLIENT_ID
    const clientSecret = process.env.ORVANE_OIDC_CLIENT_SECRET
    if (!clientId || !clientSecret) throw new Error('set ORVANE_OIDC_CLIENT_ID and ORVANE_OIDC_CLIENT_SECRET to log in to the validator')
    return { tokenUrl: oidc.tokenUrl, clientId, clientSecret, audience: cfg.ledger.audience, scope: oidc.scope }
  }
  // the well-known secret must never reach a real network
  if (cfg.network !== 'localnet' && !process.env.LEDGER_AUTH_SECRET) {
    throw new Error(`config/pairs.${cfg.network}.json has no ledger.oidc: only LocalNet takes the development login`)
  }
  return { secret: process.env.LEDGER_AUTH_SECRET ?? 'unsafe', audience: cfg.ledger.audience }
}

const DARS = [
  new URL('../daml/orvane/.daml/dist/orvane-0.1.0.dar', import.meta.url),
  // the official test token, for LocalNet pairs; a no-op where it is loaded
  new URL('../daml/dars/splice-test-token-v2-1.0.2.dar', import.meta.url),
]

export interface Network {
  cfg: NetworkConfig
  admin: JsonLedger
  ledger: JsonLedger
  operator: string
  registries: Registries
  instruments: Record<string, InstrumentId>
  labels: Record<string, string>
  // each pool with its rules and the order desk wallets place orders at
  pools: Map<string, { rulesCid: string; terms: PoolTerms; desk: DisclosedContract }>
  log: (...args: unknown[]) => void
}

export const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args)

async function retry<T>(what: string, fn: () => Promise<T>, attempts = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= attempts) throw err
      if (i === 1) log(`${what}: waiting (${err instanceof Error ? err.message.slice(0, 120) : err})`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function uploadDars(cfg: NetworkConfig) {
  const auth = authFor(cfg)
  // Providers and traders are hosted on the user participants, and they are
  // stakeholders of Orvane contracts, so every participant needs the package.
  const targets = [cfg.ledger.url, ...cfg.userParticipants].map((url) => new JsonLedger(url, cfg.ledger.adminUser, auth))
  for (const dar of DARS) {
    let bytes: Buffer
    try {
      bytes = await readFile(dar)
    } catch {
      throw new Error(`missing ${dar.pathname}. Run "dpm build --all" in daml/ first.`)
    }
    for (const target of targets) await retry(`upload to ${target.baseUrl}`, () => target.uploadDar(bytes))
  }
}

async function ensureParty(admin: JsonLedger, hint: string, known: string[]) {
  return known.find((p) => p.startsWith(`${hint}::`)) ?? (await admin.allocateParty(hint))
}

export async function connect(opts: { setup: boolean } = { setup: true }): Promise<Network> {
  const cfg = await loadConfig()
  const admin = new JsonLedger(cfg.ledger.url, cfg.ledger.adminUser, authFor(cfg))
  await retry(`ledger at ${cfg.ledger.url}`, () => admin.ledgerEnd(), 90)
  if (opts.setup) await uploadDars(cfg)

  const known = await admin.listParties()
  const operator = await ensureParty(admin, cfg.operatorHint, known)
  const tokenAdmins = new Map<string, string>()
  for (const t of cfg.testTokens) tokenAdmins.set(t.id, await ensureParty(admin, t.adminHint, known))
  // One ledger user acts for the operator and the test-token admins it
  // serves the registry for.
  await admin.ensureUser(cfg.ledger.appUser, [operator, ...tokenAdmins.values()])
  const ledger = admin.as(cfg.ledger.appUser)

  const scan = await retry('scan', () => ScanRegistry.connect(cfg.scan))
  const registries = new Registries().add(scan)
  for (const tokenAdmin of tokenAdmins.values()) registries.add(new TestTokenRegistry(() => ledger, tokenAdmin))

  const instruments: Network['instruments'] = {}
  const labels: Network['labels'] = {}
  for (const [key, i] of Object.entries(cfg.instruments)) {
    const admin = i.registry === 'scan' ? scan.admin : tokenAdmins.get(i.id)
    if (!admin) throw new Error(`instrument ${key}: no test token "${i.id}" in the config`)
    instruments[key] = { admin, id: i.id }
    labels[key] = i.label
  }

  const net: Network = { cfg, admin, ledger, operator, registries, instruments, labels, pools: new Map(), log }
  if (opts.setup) {
    for (const tokenAdmin of tokenAdmins.values()) await ensureTestTokenRules(net, tokenAdmin)
  }
  await loadPools(net, opts.setup)
  return net
}

async function ensureTestTokenRules(net: Network, tokenAdmin: string) {
  const rules = await net.ledger.query<{ admin: string }>(tokenAdmin, [TEST_TOKEN.TokenRules])
  if (rules.some((r) => r.payload.admin === tokenAdmin)) return
  net.log(`opening the test-token registry for ${tokenAdmin.split('::')[0]}`)
  await net.ledger.submit([tokenAdmin], [{ CreateCommand: { templateId: TEST_TOKEN.TokenRules, createArguments: { admin: tokenAdmin } } }], [], [], `orvane:setup:v1:rules:${tokenAdmin}`)
}

// Pools are created once from the config. Their terms never change on the
// ledger, so a config that no longer matches is reported, not applied.
async function loadPools(net: Network, create: boolean) {
  const existing = await net.ledger.query<PoolRules>(net.operator, [DEX.PoolRules])
  for (const p of net.cfg.pools) {
    const terms: PoolTerms = {
      operator: net.operator,
      poolId: p.poolId,
      instrumentA: pick(net, p.a),
      instrumentB: pick(net, p.b),
      feeBps: p.feeBps,
      maxPositions: p.maxPositions,
      minTermSeconds: p.minTermSeconds,
      maxTermSeconds: p.maxTermSeconds,
      ratioToleranceBps: p.ratioToleranceBps,
    }
    let found = existing.find((r) => r.payload.poolId === p.poolId)
    if (!found && create) {
      net.log(`opening pool ${p.poolId}`)
      await net.ledger.submit(
        [net.operator],
        [createPoolRules(terms)],
        [],
        [],
        `orvane:setup:v1:pool:${p.poolId}`,
      )
      const rules = (await net.ledger.query<PoolRules>(net.operator, [DEX.PoolRules])).find((r) => r.payload.poolId === p.poolId)!
      await net.ledger.submit(
        [net.operator],
        [{ ExerciseCommand: { templateId: DEX.PoolRules, contractId: rules.contractId, choice: 'PoolRules_Open', choiceArgument: {} } }],
        [],
        [],
        `orvane:setup:v1:open:${p.poolId}`,
      )
      found = rules
    }
    if (!found) continue
    const drift = describeDrift(found.payload, terms)
    if (drift) net.log(`pool ${p.poolId} on the ledger differs from the config (${drift}); the ledger wins`)
    const desk = await ensureDesk(net, p.poolId, create)
    if (!desk) continue
    net.pools.set(p.poolId, { rulesCid: found.contractId, terms: fromLedger(found.payload), desk })
  }
}

// The desk of a pool, as a contract wallets can be handed (it is the
// operator's, so they need it disclosed to exercise it).
async function ensureDesk(net: Network, poolId: string, create: boolean): Promise<DisclosedContract | undefined> {
  const find = async () => (await net.ledger.queryDisclosable<{ poolId: string }>(net.operator, [DEX.OrderDesk])).find((d) => d.payload.poolId === poolId)
  let desk = await find()
  if (!desk && create) {
    net.log(`opening the order desk for ${poolId}`)
    await net.ledger.submit(
      [net.operator],
      [{ CreateCommand: { templateId: DEX.OrderDesk, createArguments: { operator: net.operator, poolId } } }],
      [],
      [],
      `orvane:setup:v1:desk:${poolId}`,
    )
    desk = await find()
  }
  return desk?.disclosed
}

const pick = (net: Network, key: string): InstrumentId => {
  const i = net.instruments[key]
  if (!i) throw new Error(`unknown instrument "${key}" in a pool`)
  return { admin: i.admin, id: i.id }
}

function fromLedger(r: PoolRules): PoolTerms {
  return {
    operator: r.operator,
    poolId: r.poolId,
    instrumentA: r.instrumentA,
    instrumentB: r.instrumentB,
    feeBps: Number(r.feeBps),
    maxPositions: Number(r.maxPositions),
    minTermSeconds: seconds(r.minTerm),
    maxTermSeconds: seconds(r.maxTerm),
    ratioToleranceBps: Number(r.ratioToleranceBps),
  }
}

function describeDrift(r: PoolRules, want: PoolTerms): string | undefined {
  const have = fromLedger(r)
  const diffs: string[] = []
  if (!sameInstrument(have.instrumentA, want.instrumentA) || !sameInstrument(have.instrumentB, want.instrumentB)) diffs.push('instruments')
  for (const k of ['feeBps', 'maxPositions', 'minTermSeconds', 'maxTermSeconds', 'ratioToleranceBps'] as const) {
    if (have[k] !== want[k]) diffs.push(`${k} ${have[k]} vs ${want[k]}`)
  }
  return diffs.join(', ') || undefined
}
