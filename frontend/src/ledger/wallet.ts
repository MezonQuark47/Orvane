// Wallet connections over CIP-0103, the Canton dApp standard.
//
// Two wallets speak it today: the official Wallet Gateway (what LocalNet
// runs) and Five North's Loop (DevNet and MainNet). Orvane never holds keys
// or ledger credentials: every command is signed in the wallet, and every
// read of the user's own contracts goes through the wallet's ledger
// connection, so the browser only ever sees what that user's node holds.

import { DappClient, RemoteAdapter } from '@canton-network/dapp-sdk'
import { loop } from '@fivenorth/loop-sdk'
import { JsonLedger } from '../../../shared/ledger.ts'
import type { DisclosedContract } from '../../../shared/dex.ts'
import { GATEWAY_URL } from './gateway.ts'

export type WalletKind = 'gateway' | 'loop'

export interface WalletSession {
  kind: WalletKind
  name: string
  party: string
  /** reads the user's own node, through the wallet */
  ledger: JsonLedger
  submit: (commands: unknown[], disclosed: DisclosedContract[], commandId?: string) => Promise<{ updateId?: string }>
  disconnect: () => Promise<void>
}

// The minimal CIP-0103 provider surface both wallets implement.
interface Cip103 {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

interface Account {
  partyId: string
  primary?: boolean
}

// Route JSON Ledger API calls through the wallet. Some wallets wrap the
// response body, so unwrap it if needed.
function walletLedger(provider: Cip103, party: string): JsonLedger {
  return new JsonLedger('', party, undefined, async (path, body) => {
    const res = (await provider.request({
      method: 'ledgerApi',
      params: { requestMethod: body === undefined ? 'get' : 'post', resource: path, body },
    })) as unknown
    if (res && typeof res === 'object' && 'response' in res && typeof (res as { response: unknown }).response === 'string') {
      return JSON.parse((res as { response: string }).response)
    }
    return res
  })
}

function session(kind: WalletKind, name: string, provider: Cip103, party: string, disconnect: () => Promise<void>): WalletSession {
  return {
    kind,
    name,
    party,
    ledger: walletLedger(provider, party),
    disconnect,
    submit: async (commands, disclosed, commandId) => {
      const r = (await provider.request({
        method: 'prepareExecuteAndWait',
        params: { commandId: commandId ?? crypto.randomUUID(), commands, actAs: [party], disclosedContracts: disclosed },
      })) as { tx?: { payload?: { updateId?: string } } }
      return { updateId: r?.tx?.payload?.updateId }
    },
  }
}

async function primaryParty(provider: Cip103): Promise<string> {
  const accounts = (await provider.request({ method: 'listAccounts' })) as Account[]
  const party = accounts.find((a) => a.primary)?.partyId ?? accounts[0]?.partyId
  if (!party) throw new Error('The wallet has no Canton party yet. Create one in the wallet, then connect again.')
  return party
}

export async function connectGateway(): Promise<WalletSession> {
  const client = new DappClient(new RemoteAdapter({ name: 'Wallet Gateway', rpcUrl: GATEWAY_URL }).provider())
  const provider = client.getProvider() as unknown as Cip103
  const result = await client.connect()
  if (!result.isConnected) throw new Error(result.reason ?? 'The wallet did not connect')
  const party = await primaryParty(provider)
  return session('gateway', 'Wallet Gateway', provider, party, () => client.disconnect())
}

let loopReady = false
export async function connectLoop(network: 'devnet' | 'mainnet'): Promise<WalletSession> {
  if (!loopReady) {
    loop.init({ appName: 'Orvane', network })
    loopReady = true
  }
  const provider = loop.getCip103Provider() as unknown as Cip103
  await provider.request({ method: 'connect' })
  const party = await primaryParty(provider)
  return session('loop', 'Loop', provider, party, async () => {
    await provider.request({ method: 'disconnect' })
  })
}
