// Orvane's proxy for token-standard transfers.
//
// A swap is one transfer from the user's wallet to Cantex. Sent through
// Splice's `WalletUserProxy` (package splice-util-featured-app-proxies, by
// Digital Asset), the same transfer runs inside one exercise on a contract that
// Orvane signs, so Orvane's party confirms the transaction. Under traffic-based
// app rewards (CIP-0104), featured apps that confirm a user's transaction share
// its traffic fee as app activity. The proxy cannot change the transfer: it runs
// exactly the factory call the user signs.
//
// No featured app right is passed, so no activity markers are created: under
// the marker rules a non-wallet app may only mark its own traffic.

import type { DamlCommand } from './ledger.ts'
import type { DisclosedContract } from './dex.ts'

export const PROXY_TEMPLATE = '#splice-util-featured-app-proxies:Splice.Util.FeaturedApp.WalletUserProxy:WalletUserProxy'
export const TRANSFER_FACTORY_V1 = '#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory'

/** What the app needs to route transfers through Orvane's proxy on one network. */
export interface ProxyInfo {
  /** Orvane's app provider party, the proxy's signatory */
  provider: string
  /** the proxy contract, disclosed with every transfer that uses it */
  contract: DisclosedContract
}

/** A V1 `TransferFactory_Transfer` call, as a wallet or registry prepares it. */
export interface FactoryExercise {
  factoryCid: string
  choiceArg: {
    expectedAdmin: string
    transfer: {
      sender: string
      receiver: string
      amount: string
      instrumentId: { admin: string; id: string }
      requestedAt: string
      executeBefore: string
      inputHoldingCids: string[]
      meta: { values: Record<string, string> }
    }
    extraArgs: unknown
  }
}

const sameTemplateName = (a: string, b: string) => a.split(':').slice(-2).join(':') === b.split(':').slice(-2).join(':')

/** The transfer, run through the proxy: one root action, the user as the only controller. */
export function wrapTransfer(proxy: ProxyInfo, call: FactoryExercise): DamlCommand {
  return {
    ExerciseCommand: {
      templateId: PROXY_TEMPLATE,
      contractId: proxy.contract.contractId,
      choice: 'WalletUserProxy_BatchTransfer',
      choiceArgument: { transferCalls: [call], optFeaturedAppRightCid: null },
    },
  }
}

/**
 * Pick the single V1 `TransferFactory_Transfer` out of a prepared command
 * list. Anything else (a second command, another choice, a V2 factory) is
 * refused, so the proxy only ever wraps a plain transfer.
 */
export function factoryExerciseOf(commands: unknown[]): FactoryExercise {
  if (commands.length !== 1) throw new Error(`expected one transfer command, got ${commands.length}`)
  const ex = (commands[0] as { ExerciseCommand?: { templateId: string; contractId: string; choice: string; choiceArgument: unknown } }).ExerciseCommand
  if (!ex || ex.choice !== 'TransferFactory_Transfer') throw new Error('the prepared command is not a token-standard transfer')
  if (!sameTemplateName(ex.templateId, TRANSFER_FACTORY_V1) || !ex.templateId.includes('TransferInstructionV1')) {
    throw new Error(`the prepared transfer uses ${ex.templateId}; the proxy takes token standard V1 transfers`)
  }
  return { factoryCid: ex.contractId, choiceArg: ex.choiceArgument as FactoryExercise['choiceArg'] }
}

/** Disclosed contracts for a proxied transfer: the transfer's own plus the proxy, without duplicates. */
export function proxiedDisclosed(proxy: ProxyInfo, disclosed: DisclosedContract[]): DisclosedContract[] {
  const all = [...disclosed, proxy.contract]
  return all.filter((d, i) => all.findIndex((x) => x.contractId === d.contractId) === i)
}

/** Proxy settings published with the app for one network, or undefined if there are none. */
export async function loadProxy(url: string | undefined, fetcher: typeof fetch = fetch): Promise<ProxyInfo | undefined> {
  if (!url) return undefined
  const res = await fetcher(url)
  if (!res.ok) return undefined
  const p = (await res.json()) as Partial<ProxyInfo>
  return p.provider && p.contract?.contractId && p.contract.createdEventBlob ? (p as ProxyInfo) : undefined
}

/**
 * The proxied transfer cannot be prepared on the user's node (for example the
 * proxy package is not loaded there). Raised before anything is signed, so
 * the caller can send the plain transfer instead.
 */
export class ProxyUnavailable extends Error {}
