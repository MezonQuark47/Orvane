// End-to-end check of Orvane's transfer proxy on a running LocalNet, after
// `node scripts/proxy-setup.ts`.
//
// A user on the app-user participant sends Canton Coin with a memo to a
// receiver on the app-provider participant (standing in for Cantex's swap
// party), through the proxy. Checks:
//   - the transaction's root is the proxy's batch transfer, with the token
//     standard transfer under it, the memo intact and no activity markers
//   - Orvane's participant confirmed it (Orvane's party sees the transfer)
//   - what Scan records as app activity for the transaction (CIP-0104)
//
//   node scripts/e2e-proxy.ts

import { readFile } from 'node:fs/promises'
import { JsonLedger, hmacJwt } from '../shared/ledger.ts'
import { Scan, tapAmulet, holdingsOf, extraArgsFrom } from '../shared/amulet.ts'
import { factoryExerciseOf, proxiedDisclosed, wrapTransfer, TRANSFER_FACTORY_V1, type ProxyInfo } from '../shared/proxy.ts'
import { authFor, loadConfig } from '../operator/network.ts'

const REASON = 'splice.lfdecentralizedtrust.org/reason'
const MEMO = 'USDCx'

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

// the user, on the user participant; the receiver on Orvane's side
const run = Date.now().toString(36)
const userAdmin = new JsonLedger(cfg.userParticipants[0], cfg.ledger.adminUser, auth)
const sender = await userAdmin.allocateParty(`e2e-proxy-user-${run}`)
await userAdmin.ensureUser('orvane-e2e', [sender])
const user = userAdmin.as('orvane-e2e')
const providerAdmin = new JsonLedger(cfg.ledger.url, cfg.ledger.adminUser, auth)
const receiver = await providerAdmin.allocateParty(`e2e-proxy-receiver-${run}`)
await providerAdmin.ensureUser(cfg.ledger.appUser, [receiver, proxy.provider])

await tapAmulet(user, scan, sender, 100)
const inputs = (await holdingsOf(user, sender)).filter((h) => h.view.lock === null).map((h) => h.contractId)

// the transfer exactly as a wallet would prepare it from the registry
const now = Date.now()
const choiceArguments = {
  expectedAdmin: cc.admin,
  transfer: {
    sender,
    receiver,
    amount: '60.0',
    instrumentId: cc,
    requestedAt: new Date(now - 5_000).toISOString(),
    executeBefore: new Date(now + 3_600_000).toISOString(),
    inputHoldingCids: inputs,
    meta: { values: { [REASON]: MEMO } },
  },
  extraArgs: { context: { values: {} }, meta: { values: {} } },
}
const factory = await scan.transferFactory(choiceArguments)
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

// through the proxy
const tx = await user.submit(
  [sender],
  [wrapTransfer(proxy, factoryExerciseOf(prepared))],
  [],
  proxiedDisclosed(proxy, factory.choiceContext.disclosedContracts),
)
console.log(`  transaction ${tx.updateId}`)

type Ev = Record<string, { templateId?: string; choice?: string; choiceArgument?: unknown; createArgument?: unknown } | undefined>
const events = tx.events as unknown as Ev[]
const exercised = events.map((e) => e.ExercisedEvent).filter((e) => !!e)
const created = events.map((e) => e.CreatedEvent).filter((e) => !!e)
check('the root action is the proxy batch transfer', exercised[0]?.choice === 'WalletUserProxy_BatchTransfer', JSON.stringify(exercised[0]?.choice))
check('the token standard transfer runs inside it', exercised.some((e) => e.choice === 'TransferFactory_Transfer'))
check('no activity markers are created', !created.some((e) => /FeaturedAppActivityMarker/.test(e.templateId ?? '')))
const instr = created.find((e) => /AmuletTransferInstruction/.test(e.templateId ?? ''))
const memo = (instr?.createArgument as { transfer?: { meta?: { values?: Record<string, string> } } } | undefined)?.transfer?.meta?.values?.[REASON]
check('the memo reaches the transfer', memo === MEMO, JSON.stringify(memo))

// Orvane's party is an informee of the root action, so its participant
// validated and confirmed the transaction and has it
const res = await fetch(`${cfg.ledger.url}/v2/updates/update-by-id`, {
  method: 'POST',
  headers: { authorization: `Bearer ${await hmacJwt(auth, cfg.ledger.appUser)}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    updateId: tx.updateId,
    updateFormat: {
      includeTransactions: {
        eventFormat: { filtersByParty: { [proxy.provider]: { cumulative: [] } }, verbose: true },
        transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS',
      },
    },
  }),
})
const orvaneView = res.ok ? JSON.stringify(await res.json()) : ''
check("Orvane's participant has the transaction", orvaneView.includes('WalletUserProxy_BatchTransfer'), `${res.status}`)
check("Orvane's view includes the transfer", orvaneView.includes(sender) && orvaneView.includes(MEMO))

// CIP-0104: what Scan attributes to whom
for (let i = 0; i < 15; i++) {
  const res = await fetch(`${cfg.scan}/api/scan/v0/events/${encodeURIComponent(tx.updateId)}?daml_value_encoding=compact_json`)
  if (res.ok) {
    const body = (await res.json()) as { traffic_summary?: unknown; app_activity_records?: unknown }
    console.log('  scan traffic_summary:', JSON.stringify(body.traffic_summary ?? null))
    console.log('  scan app_activity_records:', JSON.stringify(body.app_activity_records ?? null))
    const records = JSON.stringify(body.app_activity_records ?? '')
    check('Scan records app activity for Orvane', records.includes(proxy.provider), records.slice(0, 300))
    break
  }
  if (i === 14) check('Scan has the transaction', false, `${res.status} ${(await res.text()).slice(0, 200)}`)
  await new Promise((r) => setTimeout(r, 2_000))
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
