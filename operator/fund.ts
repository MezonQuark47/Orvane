// Developer-only: send LocalNet test funds to a party.
//
// Wallet parties are external, so nobody can create tokens in their accounts
// directly. Both assets arrive as token-standard transfer offers that the
// receiver accepts (Orvane's Portfolio page lists them under "Incoming"):
//   TestUSD  minted by the test token's admin (TokenRules_OfferMint)
//   CC       tapped by the operator on LocalNet, then transferred
//
//   node operator/fund.ts <party> [--usd 1000] [--cc 5000]

import { pathToFileURL } from 'node:url'
import { Scan, tapAmulet } from '../shared/amulet.ts'
import { show, dec } from '../shared/decimal.ts'
import { HOLDING_V2, basicAccount, type InstrumentId } from '../shared/dex.ts'
import { TEST_TOKEN, dedupeDisclosed } from '../shared/registry.ts'
import { connect, type Network } from './network.ts'

const TRANSFER_FACTORY_V2 = '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory'

const past = () => new Date(Date.now() - 5_000).toISOString()

export async function offerTestToken(net: Network, instrument: InstrumentId, receiver: string, amount: number) {
  const rules = (await net.ledger.query<{ admin: string }>(instrument.admin, [TEST_TOKEN.TokenRules])).find((r) => r.payload.admin === instrument.admin)
  if (!rules) throw new Error(`no test-token rules for ${instrument.id}`)
  await net.ledger.submit([instrument.admin], [
    {
      ExerciseCommand: {
        templateId: TEST_TOKEN.TokenRules,
        contractId: rules.contractId,
        choice: 'TokenRules_OfferMint',
        choiceArgument: {
          receiver: basicAccount(receiver),
          amount: show(dec(amount)),
          instrumentId: instrument,
          offeredAt: past(),
          receiverConfig: {
            admin: instrument.admin,
            account: basicAccount(receiver),
            ownerConfig: { canInitiate: true, mustApprove: true },
            providerConfig: { canInitiate: false, mustApprove: false },
          },
        },
      },
    },
  ])
}

interface HoldingView {
  account: { owner: string | null }
  instrumentId: InstrumentId
  amount: string
  lock: unknown
}

export async function sendCanton(net: Network, cc: InstrumentId, receiver: string, amount: number) {
  const { operator } = net
  await tapAmulet(net.ledger, new Scan(net.cfg.scan), operator, amount)
  const holdings = (await net.ledger.queryInterface<HoldingView>(operator, HOLDING_V2)).filter(
    (h) => h.view.account.owner === operator && h.view.instrumentId.admin === cc.admin && h.view.instrumentId.id === cc.id && !h.view.lock,
  )
  const now = Date.now()
  const transfer = {
    sender: basicAccount(operator),
    receiver: basicAccount(receiver),
    amount: show(dec(amount)),
    instrumentId: cc,
    requestedAt: new Date(now - 5_000).toISOString(),
    executeBefore: new Date(now + 7 * 86_400_000).toISOString(),
    inputHoldingCids: holdings.map((h) => h.contractId),
    meta: { values: {} },
  }
  const choiceArguments = { transfer, actors: [operator], extraArgs: { context: { values: {} }, meta: { values: {} } } }
  const factory = await net.registries.for(cc.admin).transferFactory(choiceArguments)
  await net.ledger.submit(
    [operator],
    [{ ExerciseCommand: { templateId: TRANSFER_FACTORY_V2, contractId: factory.factoryId, choice: 'TransferFactory_Transfer', choiceArgument: { ...choiceArguments, extraArgs: factory.extraArgs } } }],
    [],
    dedupeDisclosed(factory.disclosed),
  )
}

// ---------- command line ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const party = args.find((a) => !a.startsWith('--') && !/^\d/.test(a))
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? Number(args[i + 1]) : 0
  }
  const usd = flag('usd')
  const cc = flag('cc')
  if (!party || (!usd && !cc)) {
    console.error('usage: node operator/fund.ts <party> [--usd 1000] [--cc 5000]')
    process.exit(1)
  }
  const net = await connect({ setup: false })
  if (net.cfg.network !== 'localnet') throw new Error('test funds exist on LocalNet only')
  if (usd) {
    await offerTestToken(net, net.instruments.TestUSD, party, usd)
    net.log(`offered ${usd} TestUSD to ${party.split('::')[0]}`)
  }
  if (cc) {
    await sendCanton(net, net.instruments.CC, party, cc)
    net.log(`offered ${cc} CC to ${party.split('::')[0]}`)
  }
  net.log('the receiver accepts them under Portfolio > Incoming')
}
