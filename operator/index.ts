// Orvane operator: the executor of the Orvane DEX.
//
// On start it makes sure the network is set up (packages on every
// participant, the operator party, the pools from config/pairs.<network>.json),
// then serves the public API for the web app and settles whatever traders
// and providers file. It holds no funds and creates no demo data.
//
//   ORVANE_NETWORK=localnet node operator/index.ts

import { connect } from './network.ts'
import { serve } from './api.ts'
import { settleOnce } from './settle.ts'

const PORT = Number(process.env.OPERATOR_PORT ?? 7600)
const TICK_MS = 1_000

const net = await connect()
net.log(`operator ${net.operator.split('::')[0]} on ${net.cfg.network} with ${net.pools.size} pool(s)`)
serve(net, PORT)

// ORVANE_SETTLE=off serves the API (and the LocalNet test-token registry)
// without settling anything: how the network looks to users while the
// operator's settlement is down.
if (process.env.ORVANE_SETTLE === 'off') {
  net.log('settlement is off; serving the API only')
  await new Promise(() => {})
}

for (;;) {
  try {
    await settleOnce(net)
  } catch (err) {
    net.log('settle error', err instanceof Error ? err.message : err)
  }
  await new Promise((r) => setTimeout(r, TICK_MS))
}
