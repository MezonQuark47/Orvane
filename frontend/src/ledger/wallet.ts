// Wallet connections over CIP-0103, the Canton dApp standard.
//
// Orvane never holds keys or ledger credentials: every command is signed in
// the user's wallet, and every read of the user's own contracts goes through
// the wallet's ledger connection.
//
// Wallets:
//   Loop             Five North's wallet (TestNet, MainNet). Swaps use Loop's own
//                    transfer, which prepares the token-standard transfer for any token.
//   Browser wallet   any CIP-0103 browser-extension wallet
//   Wallet Gateway   the reference CIP-0103 gateway (LocalNet, or an institution's own)

import { DappClient, ExtensionAdapter, RemoteAdapter } from '@canton-network/dapp-sdk'
import { loop } from '@fivenorth/loop-sdk'
import { JsonLedger } from '../../../shared/ledger.ts'
import type { DisclosedContract } from '../../../shared/dex.ts'
import type { Instrument } from '../../../shared/cantex.ts'
import { GATEWAY_URL } from './gateway.ts'

export type WalletKind = 'loop' | 'extension' | 'gateway'

export interface LoopAccount {
  /** can receive Canton Coin in one step */
  hasPreapproval: boolean
  /** instrument admins the account can receive from in one step */
  preapprovalAdmins: string[]
  usdcBridge: 'not_requested' | 'pending' | 'granted' | undefined
}

export interface WalletSession {
  kind: WalletKind
  name: string
  party: string
  /** reads the user's own node, through the wallet */
  ledger: JsonLedger
  submit: (commands: unknown[], disclosed: DisclosedContract[], commandId?: string) => Promise<{ updateId?: string }>
  /**
   * A plain token-standard transfer prepared by the wallet itself (Loop).
   * Wallets without it get transfers built by Orvane from the token's
   * registry instead.
   */
  transfer?: (recipient: string, amount: string, instrument: Instrument, memo: string) => Promise<void>
  account?: () => Promise<LoopAccount>
  /** balances as the wallet itself reports them (Loop), per token: free and locked */
  balances?: () => Promise<Array<{ instrument: Instrument; free: string; locked: string }>>
  /** the wallet's own web app, where settings like receiving pre-approvals live */
  walletUrl?: string
  bridgeUsdcx?: (ethereumAddress: string, amount: string) => Promise<void>
  disconnect: () => Promise<void>
}

// The minimal CIP-0103 provider surface every wallet implements.
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

async function connectWith(kind: WalletKind, name: string, client: DappClient): Promise<WalletSession> {
  const provider = client.getProvider() as unknown as Cip103
  const result = await client.connect()
  if (!result.isConnected) throw new Error(result.reason ?? 'The wallet did not connect')
  const party = await primaryParty(provider)
  return session(kind, name, provider, party, () => client.disconnect())
}

export const connectGateway = (url = GATEWAY_URL) => connectWith('gateway', 'Wallet Gateway', new DappClient(new RemoteAdapter({ name: 'Wallet Gateway', rpcUrl: url }).provider()))

// A CIP-0103 wallet installed as a browser extension, if there is one.
export async function extensionAvailable(): Promise<boolean> {
  try {
    return await new ExtensionAdapter().detect()
  } catch {
    return false
  }
}
export const connectExtension = () => connectWith('extension', 'Browser wallet', new DappClient(new ExtensionAdapter().provider(), { providerType: 'browser' }))

// ---------- Loop ----------

// Loop's own provider, handed over when the user accepts the connection. It
// adds what the CIP-0103 surface does not: account status and transfers that
// Loop prepares for any token.
interface LoopNative {
  getAccount(): Promise<{ has_preapproval?: boolean; utility_preapproval_admins?: string[]; usdc_bridge_access?: LoopAccount['usdcBridge'] }>
  getHolding(): Promise<Array<{ instrument_id: { admin: string; id: string }; total_unlocked_coin: string; total_locked_coin: string }>>
  transfer(recipient: string, amount: string, instrument: { instrument_admin: string; instrument_id: string }, options: { memo: string; executionMode: 'wait'; requestTimeout?: number; message?: string }): Promise<unknown>
}

let loopNetwork: string | undefined
let loopNative: LoopNative | undefined

export async function connectLoop(network: 'testnet' | 'mainnet'): Promise<WalletSession> {
  if (loopNetwork !== network) {
    loop.init({
      appName: 'Orvane',
      network,
      onAccept: (p) => {
        loopNative = p as unknown as LoopNative
      },
    })
    loopNetwork = network
  }
  const provider = loop.getCip103Provider() as unknown as Cip103
  await provider.request({ method: 'connect' })
  const party = await primaryParty(provider)
  const s = session('loop', 'Loop', provider, party, async () => {
    await provider.request({ method: 'disconnect' })
  })
  const native = () => {
    if (!loopNative) throw new Error('Loop is not ready yet. Reconnect the wallet and try again.')
    return loopNative
  }
  return {
    ...s,
    walletUrl: network === 'mainnet' ? 'https://wallet.looptech.io' : 'https://wallet.testnet.looptech.io',
    transfer: async (recipient, amount, instrument, memo) => {
      await native().transfer(recipient, amount, { instrument_admin: instrument.admin, instrument_id: instrument.id }, {
        memo,
        executionMode: 'wait',
        requestTimeout: 180_000,
        message: `Swap through Orvane: ${amount} ${instrument.id}`,
      })
    },
    balances: async () => {
      const rows = await native().getHolding()
      return rows.map((h) => ({ instrument: { admin: h.instrument_id.admin, id: h.instrument_id.id }, free: h.total_unlocked_coin, locked: h.total_locked_coin }))
    },
    account: async () => {
      const a = await native().getAccount()
      return { hasPreapproval: !!a.has_preapproval, preapprovalAdmins: a.utility_preapproval_admins ?? [], usdcBridge: a.usdc_bridge_access }
    },
    bridgeUsdcx: async (ethereumAddress, amount) => {
      await loop.wallet.extension.usdcBridge.withdrawalUSDCxToEthereum(ethereumAddress, amount, { requestTimeout: 180_000 })
    },
  }
}
