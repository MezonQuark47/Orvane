// Sets up Orvane's transfer proxy on a network and publishes it for the app.
//
//   1. loads Splice's featured-app proxy package on every participant that
//      hosts Orvane or its users (it is not loaded on validators by default)
//   2. Orvane's app provider party
//   3. LocalNet only: makes that party a featured app (DevNet rules allow a
//      party to feature itself; real networks decide this by an SV vote)
//   4. one WalletUserProxy signed by Orvane, reused if it exists
//   5. writes frontend/public/orvane-proxy.<network>.json, which the app
//      discloses with every proxied transfer
//
// Idempotent: running it again changes nothing that is already in place.
//
//   node scripts/proxy-setup.ts

import { readFile, writeFile } from 'node:fs/promises'
import { JsonLedger } from '../shared/ledger.ts'
import { Scan } from '../shared/amulet.ts'
import { PROXY_TEMPLATE, type ProxyInfo } from '../shared/proxy.ts'
import { authFor, loadConfig, log } from '../operator/network.ts'

const PROXY_DAR = new URL('../daml/dars/splice-util-featured-app-proxies-1.2.5.dar', import.meta.url)
const FEATURED_APP_RIGHT = '#splice-amulet:Splice.Amulet:FeaturedAppRight'
const PROVIDER_HINT = 'orvane-app'

const cfg = await loadConfig()
const auth = authFor(cfg)
const admin = new JsonLedger(cfg.ledger.url, cfg.ledger.adminUser, auth)

// 1. the package, on Orvane's participant and the users'
const dar = await readFile(PROXY_DAR)
for (const url of [cfg.ledger.url, ...cfg.userParticipants]) {
  await new JsonLedger(url, cfg.ledger.adminUser, auth).uploadDar(dar)
  log(`proxy package loaded on ${url}`)
}

// 2. the provider party, acted for by Orvane's ledger user
const known = await admin.listParties()
const provider = known.find((p) => p.startsWith(`${PROVIDER_HINT}::`)) ?? (await admin.allocateParty(PROVIDER_HINT))
await admin.ensureUser(cfg.ledger.appUser, [provider])
const ledger = admin.as(cfg.ledger.appUser)
log(`provider ${provider}`)

// 3. featured, on LocalNet
if (cfg.network === 'localnet') {
  const rights = await ledger.query<{ provider: string }>(provider, [FEATURED_APP_RIGHT])
  if (rights.some((r) => r.payload.provider === provider)) {
    log('already a featured app')
  } else {
    const rules = await new Scan(cfg.scan).amuletRules()
    await ledger.submit(
      [provider],
      [
        {
          ExerciseCommand: {
            templateId: rules.contract.template_id,
            contractId: rules.contract.contract_id,
            choice: 'AmuletRules_DevNet_FeatureApp',
            choiceArgument: { provider, activityWeight: null, appKind: null, opsParties: null },
          },
        },
      ],
      [],
      [rules.disclosed],
      `orvane:proxy:v1:feature:${provider}`,
    )
    log('featured (DevNet rules)')
  }
}

// 4. the proxy
const mine = async () =>
  (await ledger.queryDisclosable<{ provider: string }>(provider, [PROXY_TEMPLATE])).find((c) => c.payload.provider === provider)
let proxy = await mine()
if (!proxy) {
  await ledger.submit(
    [provider],
    [
      {
        CreateCommand: {
          templateId: PROXY_TEMPLATE,
          createArguments: { provider, providerWeight: '1.0', userWeight: '0.0', extraBeneficiaries: [], optAllowList: null },
        },
      },
    ],
    [],
    [],
    `orvane:proxy:v1:create:${provider}`,
  )
  proxy = await mine()
  if (!proxy) throw new Error('the proxy was created but is not visible to its provider')
  log('proxy created')
} else {
  log('proxy already in place')
}

// 5. publish it for the app
const info: ProxyInfo & { network: string } = { network: cfg.network, provider, contract: proxy.disclosed }
const out = new URL(`../frontend/public/orvane-proxy.${cfg.network}.json`, import.meta.url)
await writeFile(out, JSON.stringify(info, null, 2) + '\n')
log(`wrote ${out.pathname}`)
