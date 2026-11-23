// One swap, start to finish:
//
//   1. quote again and check it: against the quote the user saw (their
//      slippage limit), against Orvane's own pricing from the pools, and for
//      a price impact the user has not accepted
//   2. send the sell token to the venue. Cantex (TestNet, MainNet): to its
//      swap party, with the buy token as memo. OneSwap (DevNet): to the
//      deposit party of a swap opened first, held to the user's minimum.
//      Loop prepares the transfer itself; other wallets get one built from
//      the token's registry. Where Orvane's proxy is set up, the same
//      transfer runs through it so Orvane's party confirms it (shared/proxy.ts)
//   3. watch until the output arrives: OneSwap reports its swap's state;
//      for Cantex, the user's own balance. If the wallet never said whether
//      it sent the transfer, first watch for the sell token to leave the
//      wallet (shared/settle.ts)
//
// Cantex fills at the pool price when the transfer arrives and its quote is
// not binding, so step 1 is the trader's protection.

import { show, dec, ZERO, type Dec } from '../../../shared/decimal.ts'
import { sameInstrument, type Instrument, type PoolState, type Quote, type SwapVenue } from '../../../shared/cantex.ts'
import { OneSwapApi, TERMINAL, type OneSwapOrder } from '../../../shared/oneswap.ts'
import { checkQuote, guardFreshQuote, minimumOut, CONFIRM_IMPACT_BPS, MAX_IMPACT_BPS, SWAP_TRANSFER_TTL_MS, type QuoteCheck } from '../../../shared/quote.ts'
import { arrived, moved, sent, settle, type SettledSwap } from '../../../shared/settle.ts'
import { basicAccount } from '../../../shared/dex.ts'
import { dedupeDisclosed } from '../../../shared/registry.ts'
import { loadProxy, ProxyUnavailable, type ProxyInfo } from '../../../shared/proxy.ts'
import type { DexState, Mine } from '../ledger/dex.tsx'
import { NETWORK } from '../ledger/network.ts'
import { FeeShortfall, type FeeStatus } from '../ledger/fees.ts'
import { OutcomeUnknown } from '../ledger/outcome.ts'
import { recordSwap, reviseSwaps, updateSwap } from './history.ts'

const TRANSFER_FACTORY_V2 = '#splice-api-token-transfer-instruction-v2:Splice.Api.Token.TransferInstructionV2:TransferFactory'
const REASON = 'splice.lfdecentralizedtrust.org/reason'
const FILL_WAIT_MS = 120_000
// how long to look for the transfer itself when the wallet went quiet; the
// swap history keeps watching after that
const CONFIRM_WAIT_MS = 30_000
/** How long a swap stays open: its transfer can be signed or taken until it expires, then filled. */
export const WATCH_MS = SWAP_TRANSFER_TTL_MS + 5 * 60_000

export class SwapBlocked extends Error {}

export interface SwapResult {
  /** unconfirmed: the wallet never said whether it sent the transfer, and nothing has left the wallet so far */
  status: 'filled' | 'pending' | 'unconfirmed'
  quoted: Dec
  received: Dec
  id: string
  /** when the wallet was asked to sign */
  at: number
}

export type Stage = 'checking' | 'signing' | 'confirming' | 'settling'

// the proxy settings for this network, fetched once
let proxyInfo: Promise<ProxyInfo | undefined> | undefined
export const orvaneProxy = () => (proxyInfo ??= loadProxy(NETWORK.proxy).catch(() => undefined))

/** What to tell the user when the wallet's fee balance is short. */
export const topUpMessage = (fee: FeeStatus, wallet: string) =>
  `Your ${wallet} fee balance is too low for this swap${fee.amount ? ` (needs about ${fee.amount} ${fee.asset ?? 'CC'})` : ''}. Top it up in ${wallet} first; nothing was sent.`

/** A price impact as the user reads it. */
export const impactText = (bps: number) => `${(bps / 100).toFixed(1)}%`

const freeOf = (m: Mine, i: Instrument) => m.holdings.filter((h) => !h.locked && sameInstrument(h.instrument, i)).reduce((s, h) => s + h.amount, ZERO)

// the swaps executeSwap is watching itself right now
const watching = new Set<string>()

export async function executeSwap(
  dex: DexState,
  api: SwapVenue,
  seen: Quote,
  opts: {
    slippageBps: number
    cc: Instrument
    /** the price impact the user accepted, when it was above the level that needs accepting */
    acceptedImpactBps?: number
    onStage: (s: Stage) => void
  },
): Promise<SwapResult> {
  const session = dex.wallet.phase === 'connected' ? dex.wallet.session : undefined
  if (!session || !dex.party) throw new SwapBlocked('Connect a wallet first.')
  const oneswap = api instanceof OneSwapApi ? api : undefined
  if (!oneswap && !NETWORK.cantex) throw new SwapBlocked('Swaps are not available on this network.')
  const party = dex.party
  const sell: Instrument = seen.sell
  const buy: Instrument = seen.returned

  // 1. the price right now, checked twice
  opts.onStage('checking')
  // pools move between two reads; a mismatch gets one more try before it blocks
  let fresh: Quote | undefined
  let checked: ReturnType<typeof checkPools> | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const [q, pools] = await Promise.all([api.quote(sell, buy, seen.sell.amount), api.pools()])
    fresh = q
    checked = checkPools(api.name, q, pools, opts.cc)
    if ('check' in checked) break
  }
  if (!fresh || !checked) throw new SwapBlocked(`No quote from ${api.name}.`)
  if ('problem' in checked) throw new SwapBlocked(checked.problem)
  const guard = guardFreshQuote(seen, fresh, opts.slippageBps)
  if (!guard.ok) throw new SwapBlocked(guard.reason)
  const impact = checked.check.priceImpactBps
  if (impact > MAX_IMPACT_BPS) {
    throw new SwapBlocked(`This swap would move the pool's price by ${impactText(impact)}: the pool is too thin for this amount. Nothing was sent.`)
  }
  // what the user accepted, give or take a point as the pools move
  if (impact > CONFIRM_IMPACT_BPS && (opts.acceptedImpactBps === undefined || impact > opts.acceptedImpactBps + 100)) {
    throw new SwapBlocked(`The price impact is now ${impactText(impact)}. Accept it to swap; nothing was sent.`)
  }
  if (dec(seen.sell.amount) > freeOf(dex.latest(), sell)) throw new SwapBlocked('Not enough balance for this swap.')

  // OneSwap: open the swap first. Its deposit party is where the input goes,
  // and it is held to the minimum of the quote the user saw.
  let order: OneSwapOrder | undefined
  if (oneswap) {
    try {
      order = await oneswap.order(party, fresh, show(minimumOut(dec(seen.returned.amount), opts.slippageBps)))
    } catch (e) {
      throw new SwapBlocked(`${e instanceof Error ? e.message : String(e)} Nothing was sent.`)
    }
  }
  const recipient = order?.depositParty ?? NETWORK.cantex!.swapParty
  const memo = order ? '' : fresh.memo
  // a swap OneSwap opened that never gets its deposit is closed again
  const dropOrder = () => (order ? oneswap!.cancel(order.id).catch(() => {}) : undefined)

  // Loop stops a transaction to ask for a fee top-up and drops it, so the fee
  // balance is checked here, before the wallet is asked to sign
  const via = session.transferVia ? await orvaneProxy() : undefined
  if (session.fees) {
    const fee = await session.fees(via, recipient, seen.sell.amount, sell, memo).catch(() => undefined)
    if (fee?.topUp) {
      await dropOrder()
      throw new SwapBlocked(topUpMessage(fee, session.name))
    }
  }

  // 2. send it
  const before = dex.latest()
  const record = { sell: seen.sell, quoted: fresh.returned, at: Date.now(), sellBefore: show(freeOf(before, sell)), buyBefore: show(freeOf(before, buy)) }
  const id = recordSwap(party, record)
  const swap: SettledSwap = { ...record, id, status: 'sending' }
  watching.add(id)
  try {
    opts.onStage('signing')
    let route: 'orvane' | 'direct' = 'direct'
    let answered = true
    try {
      if (via && session.transferVia) {
        try {
          route = 'orvane'
          await session.transferVia(via, recipient, seen.sell.amount, sell, memo)
        } catch (e) {
          if (e instanceof FeeShortfall) throw new SwapBlocked(topUpMessage(e.fee, session.name))
          // the user's node cannot run the proxy; nothing was signed, so send it plainly
          if (!(e instanceof ProxyUnavailable)) throw e
          route = 'direct'
        }
      }
      if (route === 'direct') {
        if (session.transfer) await session.transfer(recipient, seen.sell.amount, sell, memo)
        else await registryTransfer(dex, session.party, recipient, seen.sell.amount, sell, memo)
      }
    } catch (e) {
      // declined, or rejected by the ledger: nothing moved
      if (!(e instanceof OutcomeUnknown)) {
        updateSwap(party, id, { status: 'failed' })
        await dropOrder()
        throw e
      }
      answered = false
    }
    updateSwap(party, id, { route, status: answered ? 'pending' : 'unconfirmed' })
    // other open swaps must not read this swap's tokens as their own
    const noteSale = () => reviseSwaps(party, (rs) => moved(rs, id, sell, -dec(seen.sell.amount)))
    if (answered) noteSale()

    // 3. wait for the output to land
    let isSent = answered
    opts.onStage(isSent ? 'settling' : 'confirming')
    let end = Date.now() + (isSent ? FILL_WAIT_MS : CONFIRM_WAIT_MS)
    const quoted = dec(fresh.returned.amount)
    while (Date.now() < end) {
      // OneSwap says where its swap stands
      if (order) {
        const s = await oneswap!.getSwap(order.id).catch(() => undefined)
        if (s && s.status !== 'awaiting_deposit' && !isSent) {
          isSent = true
          updateSwap(party, id, { status: 'pending' })
          noteSale()
          opts.onStage('settling')
          end = Date.now() + FILL_WAIT_MS
        }
        if (s?.status === 'returned' && s.amountOut != null) {
          const got = dec(s.amountOut.toFixed(10))
          updateSwap(party, id, { status: 'filled', received: show(got) })
          reviseSwaps(party, (rs) => moved(rs, id, buy, got))
          return { status: 'filled', quoted, received: got, id, at: record.at }
        }
        if (s && TERMINAL.includes(s.status)) {
          // refunded, expired, failed or cancelled: no output is coming
          updateSwap(party, id, { status: isSent ? 'refunded' : 'failed' })
          const why = s.error ? ` (${s.error})` : ''
          throw new SwapBlocked(
            !isSent
              ? `The swap closed before anything arrived (${s.status}). Nothing was sent.`
              : s.status === 'refunded'
                ? `OneSwap could not fill the swap and refunded your input${why}.`
                : `OneSwap closed the swap without filling it (${s.status})${why}. Check your wallet for the refund.`,
          )
        }
        await new Promise((r) => setTimeout(r, 2_000))
        continue
      }
      await dex.refresh().catch(() => {})
      const m = dex.latest()
      // an empty read is a failed read: the wallet still holds something
      if (m.holdings.length) {
        if (!isSent && sent(swap, freeOf(m, sell))) {
          isSent = true
          updateSwap(party, id, { status: 'pending' })
          noteSale()
          opts.onStage('settling')
          end = Date.now() + FILL_WAIT_MS
        }
        const got = isSent ? arrived(swap, freeOf(m, buy)) : undefined
        if (got !== undefined) {
          updateSwap(party, id, { status: 'filled', received: show(got) })
          reviseSwaps(party, (rs) => moved(rs, id, buy, got))
          return { status: 'filled', quoted, received: got, id, at: record.at }
        }
      }
      await new Promise((r) => setTimeout(r, 1_500))
    }
    return { status: isSent ? 'pending' : 'unconfirmed', quoted, received: ZERO, id, at: record.at }
  } finally {
    watching.delete(id)
  }
}

/** Settles the swaps left open (not confirmed by the wallet, or not filled yet) from the user's latest balances. */
export function settleOpenSwaps(party: string, m: Mine) {
  if (!m.holdings.length) return
  reviseSwaps(party, (records) => settle(records, (i) => freeOf(m, i), Date.now(), WATCH_MS, (id) => watching.has(id)))
}

// Orvane's own pricing must not find the venue's quote better than the pools
// allow, and the quote must not be far worse than the pools give.
function checkPools(venue: string, q: Quote, pools: PoolState[], cc: Instrument): { check: QuoteCheck } | { problem: string } {
  try {
    const c = checkQuote(q, pools, cc, 25)
    if (c.agrees) return { check: c }
    return { problem: `${venue}'s quote (${show(c.quoted)}) does not match the pools (${show(c.expected)}). Nothing was sent; try again in a moment.` }
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) }
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
    executeBefore: new Date(now + SWAP_TRANSFER_TTL_MS).toISOString(),
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
