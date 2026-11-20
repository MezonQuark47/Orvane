// Create the ledger user a Wallet Gateway sign-in maps to, on the LocalNet
// app-user participant. The gateway's self-signed login uses the Client ID
// as the user id, and the participant only accepts users it knows.
//
//   node scripts/gateway-user.ts <client-id>

import { JsonLedger } from '../shared/ledger.ts'

const id = process.argv[2]
if (!id) {
  console.error('usage: node scripts/gateway-user.ts <client-id>')
  process.exit(1)
}

const admin = new JsonLedger('http://localhost:2975', 'ledger-api-user', { secret: process.env.LEDGER_AUTH_SECRET ?? 'unsafe', audience: 'https://canton.network.global' })
await admin.ensureUser(id, [])
console.log(`ledger user "${id}" is ready; sign in to the gateway with it (Client Secret "unsafe")`)
