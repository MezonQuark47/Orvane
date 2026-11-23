// End-to-end check of Orvane's transfer proxy on a running LocalNet, after
// `node scripts/proxy-setup.ts`, and a measurement of what it earns.
//
// A user on the app-user participant sends Canton Coin with a memo through
// the proxy, twice:
//   1. to a plain receiver: not featured, no pre-approval, so the transfer
//      waits as an instruction (Orvane is the only featured confirmer)
//   2. to a receiver set up like Cantex's swap party: a featured app with a
//      transfer pre-approval for Canton Coin, so the transfer completes at
//      once and the receiver confirms it too
// Checks for each:
//   - the root is the proxy's batch transfer, with the token standard
//     transfer under it, the memo intact and no activity markers
//   - Orvane's participant has the transaction (Orvane's party confirmed it)
//   - what Scan records as app activity (CIP-0104): the bytes credited to
//     Orvane and to the receiver
//
//   node scripts/e2e-proxy.ts

import { readFile } from 'node:fs/promises'
import { JsonLedger, hmacJwt } from '../shared/ledger.ts'
import { Scan, tapAmulet, holdingsOf, extraArgsFrom } from '../shared/amulet.ts'
import { factoryExerciseOf, proxiedDisclosed, wrapTransfer, TRANSFER_FACTORY_V1, type ProxyInfo } from '../shared/proxy.ts'
import { authFor, loadConfig } from '../operator/network.ts'

const REASON = 'splice.lfdecentralizedtrust.org/reason'
const MEMO = 'USDCx'
const FEATURED_APP_RIGHT = '#splice-amulet:Splice.Amulet:FeaturedAppRight'
const PREAPPROVAL = '#splice-amulet:Splice.AmuletRules:TransferPreapproval'
// the stand-in for Cantex's swap party, kept across runs
const CANTEX_LIKE_HINT = 'e2e-cantex-like'

let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(ok ? '  ok  ' : '  FAIL', what, ok ? '' : detail)
  if (!ok) failures++
}

const cfg = await loadConfig()
const auth = authFor(cfg)
const proxy = JSON.parse(await readFile(new URL(`../frontend/public/orvane-proxy.${cfg.network}.json`, import.meta.url), 'utf8')) as ProxyInfo
const scan = new Scan(cfg.scan)
const cc = await scan.amuletInstrument()

const run = Date.now().toString(36)
const userAdmin = new JsonLedger(cfg.userParticipants[0], cfg.ledger.adminUser, auth)
const providerAdmin = new JsonLedger(cfg.ledger.url, cfg.ledger.adminUser, auth)
const known = await providerAdmin.listParties()
const plainReceiver = await providerAdmin.allocateParty(`e2e-proxy-receiver-${run}`)
const cantexLike = known.find((p) => p.startsWith(`${CANTEX_LIKE_HINT}::`)) ?? (await providerAdmin.allocateParty(CANTEX_LIKE_HINT))
await providerAdmin.ensureUser(cfg.ledger.appUser, [plainReceiver, cantexLike, proxy.provider])
const orvane = providerAdmin.as(cfg.ledger.appUser)

// ---------- the Cantex stand-in: featured, with a pre-approval for CC ----------

async function featuredSince(party: string): Promise<number> {
  const rights = await orvane.query<{ provider: string }>(party, [FEATURED_APP_RIGHT])
  const mine = rights.find((r) => r.payload.provider === party)
  if (mine) return Date.parse(mine.createdAt ?? '') || 0
  const rules = await scan.amuletRules()
  await orvane.submit([party], [{ ExerciseCommand: { templateId: rules.contract.template_id, contractId: rules.contract.contract_id, choice: 'AmuletRules_DevNet_FeatureApp', choiceArgument: { provider: party, activityWeight: null, appKind: null, opsParties: null } } }], [], [rules.disclosed])
  console.log('  featured the Cantex stand-in')
  return Date.now()
}

async function ensurePreapproval(party: string) {
  const existing = await orvane.query<{ receiver: string }>(party, [PREAPPROVAL])
  if (existing.some((p) => p.payload.receiver === party)) return
  await tapAmulet(orvane, scan, party, 100)
  const inputs = (await holdingsOf(orvane, party)).filter((h) => h.view.lock === null).map((h) => ({ tag: 'InputAmulet', value: h.contractId }))
  const [rules, round] = await Promise.all([scan.amuletRules(), scan.openRound()])
  const now = Date.now()
  await orvane.submit(
    [party],
    [
      {
        ExerciseCommand: {
          templateId: rules.contract.template_id,
          contractId: rules.contract.contract_id,
          choice: 'AmuletRules_CreateTransferPreapproval',
          choiceArgument: {
            context: {
              amuletRules: rules.contract.contract_id,
              context: { openMiningRound: round.contract.contract_id, issuingMiningRounds: [], validatorRights: [], featuredAppRight: null },
            },
            inputs,
            receiver: party,
            provider: party,
            expiresAt: new Date(now + 30 * 24 * 3_600_000).toISOString(),
            expectedDso: cc.admin,
            optCreatedAt: new Date(now - 5_000).toISOString(),
          },
        },
      },
    ],
    [],
    [rules.disclosed, round.disclosed],
  )
  console.log('  created a CC pre-approval for the Cantex stand-in')
}

// A party only counts as a featured app from the first round that opens
// after it was featured (CIP-0104).
async function waitForRoundAfter(since: number) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${cfg.scan}/api/scan/v0/open-and-issuing-mining-rounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] }),
    }).then((x) => x.json() as Promise<{ open_mining_rounds: Record<string, { contract: { payload: { opensAt: string } } }> }>)
    const now = Date.now()
    const open = Object.values(r.open_mining_rounds).map((x) => Date.parse(x.contract.payload.opensAt)).filter((t) => t <= now)
    if (open.length && Math.min(...open) > since) return
    if (i === 0) console.log('  waiting for a mining round that opened after featuring (up to ~20 minutes)…')
    if (i > 160) throw new Error('no new mining round after 40 minutes')
    await new Promise((res) => setTimeout(res, 15_000))
  }
}

const since = await featuredSince(cantexLike)
await ensurePreapproval(cantexLike)
await waitForRoundAfter(since)

// ---------- one proxied transfer ----------

const sender = await userAdmin.allocateParty(`e2e-proxy-user-${run}`)
await userAdmin.ensureUser('orvane-e2e', [sender])
const user = userAdmin.as('orvane-e2e')
await tapAmulet(user, scan, sender, 200)

type Ev = Record<string, { templateId?: string; choice?: string; choiceArgument?: unknown; createArgument?: unknown } | undefined>
type Activity = { round_number: number; records: Array<{ party: string; weight: number }> } | null

async function proxiedTransfer(label: string, receiver: string, amount: string) {
  console.log(`\n${label}`)
  const inputs = (await holdingsOf(user, sender)).filter((h) => h.view.lock === null).map((h) => h.contractId)
  const now = Date.now()
  const choiceArguments = {
    expectedAdmin: cc.admin,
    transfer: {
      sender,
      receiver,
      amount,
      instrumentId: cc,
      requestedAt: new Date(now - 5_000).toISOString(),
      executeBefore: new Date(now + 3_600_000).toISOString(),
      inputHoldingCids: inputs,
      meta: { values: { [REASON]: MEMO } },
    },
    extraArgs: { context: { values: {} }, meta: { values: {} } },
  }
  // the transfer exactly as a wallet would prepare it from the registry
  const factory = await scan.transferFactory(choiceArguments)
  console.log(`  registry transfer kind: ${factory.transferKind}`)
  const prepared = [
    {
      ExerciseCommand: {
        templateId: TRANSFER_FACTORY_V1,
        contractId: factory.factoryId,
        choice: 'TransferFactory_Transfer',
        choiceArgument: { ...choiceArguments, extraArgs: extraArgsFrom(factory.choiceContext) },
      },
    },
  ]
  const tx = await user.submit([sender], [wrapTransfer(proxy, factoryExerciseOf(prepared))], [], proxiedDisclosed(proxy, factory.choiceContext.disclosedContracts))
  console.log(`  transaction ${tx.updateId}`)

  const events = tx.events as unknown as Ev[]
  const exercised = events.map((e) => e.ExercisedEvent).filter((e) => !!e)
  const created = events.map((e) => e.CreatedEvent).filter((e) => !!e)
  check('the root action is the proxy batch transfer', exercised[0]?.choice === 'WalletUserProxy_BatchTransfer', JSON.stringify(exercised[0]?.choice))
  const transferEx = exercised.find((e) => e.choice === 'TransferFactory_Transfer')
  check('the token standard transfer runs inside it', !!transferEx)
  check('no activity markers are created', !created.some((e) => /FeaturedAppActivityMarker/.test(e.templateId ?? '')))
  const memo = (transferEx?.choiceArgument as { transfer?: { meta?: { values?: Record<string, string> } } } | undefined)?.transfer?.meta?.values?.[REASON]
  check('the memo reaches the transfer', memo === MEMO, JSON.stringify(memo))

  // Orvane's party is an informee of the root action, so its participant
  // validated and confirmed the transaction and has it
  const res = await fetch(`${cfg.ledger.url}/v2/updates/update-by-id`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await hmacJwt(auth, cfg.ledger.appUser)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      updateId: tx.updateId,
      updateFormat: { includeTransactions: { eventFormat: { filtersByParty: { [proxy.provider]: { cumulative: [] } }, verbose: true }, transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS' } },
    }),
  })
  const orvaneView = res.ok ? JSON.stringify(await res.json()) : ''
  check("Orvane's participant has the transaction", orvaneView.includes('WalletUserProxy_BatchTransfer'), `${res.status}`)

  // CIP-0104: what Scan attributes to whom
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${cfg.scan}/api/scan/v0/events/${encodeURIComponent(tx.updateId)}?daml_value_encoding=compact_json`)
    if (r.ok) {
      const body = (await r.json()) as { traffic_summary?: { total_traffic_cost: number }; app_activity_records?: Activity }
      const total = body.traffic_summary?.total_traffic_cost ?? 0
      const records = body.app_activity_records?.records ?? []
      const byParty = (p: string) => records.find((x) => x.party === p)?.weight ?? 0
      console.log(`  traffic: ${total} bytes in total`)
      for (const x of records) console.log(`    ${x.party.split('::')[0].padEnd(28)} ${String(x.weight).padStart(6)} bytes (${((100 * x.weight) / (total || 1)).toFixed(1)}%)`)
      check('Scan records app activity for Orvane', byParty(proxy.provider) > 0, JSON.stringify(records).slice(0, 300))
      return { total, orvane: byParty(proxy.provider), receiver: byParty(receiver) }
    }
    await new Promise((x) => setTimeout(x, 2_000))
  }
  check('Scan has the transaction', false)
  return { total: 0, orvane: 0, receiver: 0 }
}

const plain = await proxiedTransfer('1. plain receiver (not featured, no pre-approval)', plainReceiver, '60.0')
const swap = await proxiedTransfer("2. Cantex-like receiver (featured, CC pre-approval)", cantexLike, '60.0')

console.log('\nOrvane per proxied transfer:')
console.log(`  alone in the transaction:        ${plain.orvane} of ${plain.total} bytes`)
console.log(`  next to a featured receiver:     ${swap.orvane} of ${swap.total} bytes (receiver ${swap.receiver})`)

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
