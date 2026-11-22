// One swap through Cantex Connect, start to finish:
//
//   1. quote again and check it: against the quote the user saw (their
//      slippage limit) and against Orvane's own pricing from the pools
//   2. send the sell token to Cantex's swap party, with the buy token as memo
//      (Loop prepares the transfer itself; other wallets get one built from
//      the token's registry). Where Orvane's proxy is set up, the same
//      transfer runs through it so Orvane's party confirms it (shared/proxy.ts)
//   3. watch the user's own balance until the output arrives
//
// Cantex fills at the pool price when the transfer arrives and its quote is
// not binding, so step 1 is the trader's protection.

import { show, dec, ZERO, type Dec } from '../../../shared/decimal.ts'
import { sameInstrument, type Instrument, type PoolState, type Quote, type CantexApi } from '../../../shared/cantex.ts'
import { checkQuote, guardFreshQuote } from '../../../shared/quote.ts'
import { basicAccount } from '../../../shared/dex.ts'
import { dedupeDisclosed } from '../../../shared/registry.ts'
import { loadProxy, ProxyUnavailable, type ProxyInfo } from '../../../shared/proxy.ts'
import type { DexState, Mine } from '../ledger/dex.tsx'
import { NETWORK } from '../ledger/network.ts'
import { FeeShortfall, type FeeStatus } from '../ledger/fees.ts'
import { recordSwap, updateSwap } from './history.ts'

const TRANSFER_FACTORY_V2 = '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory'
const REASON = 'splice.lfdecentralizedtrust.org/reason'
const FILL_WAIT_MS = 120_000

export class SwapBlocked extends Error {}

export interface SwapResult {
  status: 'filled' | 'pending'
  quoted: Dec
  received: Dec
  id: string
}

export type Stage = 'checking' | 'signing' | 'settling'

// the proxy settings for this network, fetched once
let proxyInfo: Promise<ProxyInfo | undefined> | undefined
export const orvaneProxy = () => (proxyInfo ??= loadProxy(NETWORK.proxy).catch(() => undefined))

/** What to tell the user when the wallet's fee balance is short. */
export const topUpMessage = (fee: FeeStatus, wallet: string) =>
  `Your ${wallet} fee balance is too low for this swap${fee.amount ? ` (needs about ${fee.amount} ${fee.asset ?? 'CC'})` : ''}. Top it up in ${wallet} first; nothing was sent.`

const freeOf = (m: Mine, i: Instrument) => m.holdings.filter((h) => !h.locked && sameInstrument(h.instrument, i)).reduce((s, h) => s + h.amount, ZERO)

export async function executeSwap(
  dex: DexState,
  api: CantexApi,
  seen: Quote,
  opts: { slippageBps: number; cc: Instrument; onStage: (s: Stage) => void },
): Promise<SwapResult> {
  const session = dex.wallet.phase === 'connected' ? dex.wallet.session : undefined
  if (!session) throw new SwapBlocked('Connect a wallet first.')
  const swapParty = NETWORK.cantex?.swapParty
  if (!swapParty) throw new SwapBlocked('Swaps are not available on this network.')
  const sell: Instrument = seen.sell
  const buy: Instrument = seen.returned

  // 1. the price right now, checked twice
  opts.onStage('checking')
  // pools move between two reads; a mismatch gets one more try before it blocks
  let fresh: Quote | undefined
  let problem: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const [q, pools] = await Promise.all([api.quote(sell, buy, seen.sell.amount), api.pools()])
    fresh = q
    problem = checkPools(q, pools, opts.cc)
    if (!problem) break
  }
  if (problem || !fresh) throw new SwapBlocked(problem ?? 'No quote from Cantex.')
  const guard = guardFreshQuote(seen, fresh, opts.slippageBps)
  if (!guard.ok) throw new SwapBlocked(guard.reason)
  if (dec(seen.sell.amount) > freeOf(dex.latest(), sell)) throw new SwapBlocked('Not enough balance for this swap.')
  // Loop stops a transaction to ask for a fee top-up and drops it, so the fee
  // balance is checked here, before the wallet is asked to sign
  const via = session.transferVia ? await orvaneProxy() : undefined
  if (session.fees) {
    const fee = await session.fees(via, swapParty, seen.sell.amount, sell, fresh.memo).catch(() => undefined)
    if (fee?.topUp) throw new SwapBlocked(topUpMessage(fee, session.name))
  }

  // 2. send it
  const before = freeOf(dex.latest(), buy)
  const id = recordSwap(dex.party!, { sell: seen.sell, quoted: fresh.returned, at: Date.now() })
  opts.onStage('signing')
  try {
    let route: 'orvane' | 'direct' = 'direct'
    if (via && session.transferVia) {
      try {
        await session.transferVia(via, swapParty, seen.sell.amount, sell, fresh.memo)
        route = 'orvane'
      } catch (e) {
        if (e instanceof FeeShortfall) throw new SwapBlocked(topUpMessage(e.fee, session.name))
        // the user's node cannot run the proxy; nothing was signed, so send it plainly
        if (!(e instanceof ProxyUnavailable)) throw e
      }
    }
    if (route === 'direct') {
      if (session.transfer) await session.transfer(swapParty, seen.sell.amount, sell, fresh.memo)
      else await registryTransfer(dex, session.party, swapParty, seen.sell.amount, sell, fresh.memo)
    }
    updateSwap(dex.party!, id, { route })
  } catch (e) {
    updateSwap(dex.party!, id, { status: 'failed' })
    throw e
  }

  // 3. wait for the output to land
  opts.onStage('settling')
  const end = Date.now() + FILL_WAIT_MS
  while (Date.now() < end) {
    await dex.refresh().catch(() => {})
    const now = freeOf(dex.latest(), buy)
    if (now > before) {
      const received = now - before
      updateSwap(dex.party!, id, { status: 'filled', received: show(received) })
      return { status: 'filled', quoted: dec(fresh.returned.amount), received, id }
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  updateSwap(dex.party!, id, { status: 'pending' })
  return { status: 'pending', quoted: dec(fresh.returned.amount), received: ZERO, id }
}

// Orvane's own pricing must not find Cantex's quote better than the pools
// allow, and the quote must not be far worse than the pools give.
function checkPools(q: Quote, pools: PoolState[], cc: Instrument): string | undefined {
  try {
    const c = checkQuote(q, pools, cc, 25)
    if (c.agrees) return undefined
    return `Cantex's quote (${show(c.quoted)}) does not match the pools (${show(c.expected)}). Nothing was sent; try again in a moment.`
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// For wallets without their own transfer: a V2 transfer built from the
// token's registry, which Orvane reaches through its API.
async function registryTransfer(dex: DexState, party: string, receiver: string, amount: string, instrument: Instrument, memo: string) {
  if (!NETWORK.pool) {
    throw new SwapBlocked("This wallet needs the token's registry, which Orvane cannot reach on this network yet. Connect with Loop to swap.")
  }
  const holdings = dex
    .latest()
    .holdings.filter((h) => !h.locked && sameInstrument(h.instrument, instrument))
    .map((h) => h.cid)
  const now = Date.now()
  const transfer = {
    sender: basicAccount(party),
    receiver: basicAccount(receiver),
    amount,
    instrumentId: instrument,
    requestedAt: new Date(now - 5_000).toISOString(),
    executeBefore: new Date(now + 60 * 60_000).toISOString(),
    inputHoldingCids: holdings,
    meta: { values: { [REASON]: memo } },
  }
  const args = { transfer, actors: [party], extraArgs: { context: { values: {} }, meta: { values: {} } } }
  const factory = await dex.registry(instrument.admin).transferFactory(args)
  await dex.submit(
    [{ ExerciseCommand: { templateId: TRANSFER_FACTORY_V2, contractId: factory.factoryId, choice: 'TransferFactory_Transfer', choiceArgument: { ...args, extraArgs: factory.extraArgs } } }],
    dedupeDisclosed(factory.disclosed),
  )
}
