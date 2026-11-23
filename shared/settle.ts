// Settling swaps from the user's own balances.
//
// A Connect swap is two transfers: the sell token to Cantex, then Cantex's
// output back. Wallets report balances, not transfers (Loop), so a swap
// counts as sent once the sell token's free balance is down by the amount,
// and as filled once the buy token's free balance is up. Each swap keeps the
// balances from right before it was signed; whatever another swap moves
// afterwards is taken out of them, so one swap's tokens are not read as
// another's. Balances still cannot tell two outputs of the same token apart:
// open swaps settle oldest first, and while a swap is in progress the open
// ones on the same tokens wait for it.

import { dec, show, type Dec } from './decimal.ts'
import { sameInstrument, type Amount, type Instrument } from './cantex.ts'

export type SwapStatus = 'sending' | 'unconfirmed' | 'pending' | 'filled' | 'failed' | 'refunded'

export interface SettledSwap {
  id: string
  /** when the wallet was asked to sign */
  at: number
  status: SwapStatus
  sell: Amount
  /** the buy token, with the amount quoted */
  quoted: Amount
  received?: string
  /** free balances right before the wallet was asked to sign, less what other swaps moved since */
  sellBefore?: string
  buyBefore?: string
}

const OPEN: SwapStatus[] = ['sending', 'unconfirmed', 'pending']

/** The sell token has left the wallet: its free balance is down by the amount (1% slack). */
export function sent(s: SettledSwap, freeSell: Dec): boolean {
  if (s.sellBefore === undefined) return false
  return dec(s.sellBefore) - freeSell >= (dec(s.sell.amount) * 99n) / 100n
}

/** How much of the buy token has arrived since the swap was sent, if any. */
export function arrived(s: SettledSwap, freeBuy: Dec): Dec | undefined {
  if (s.buyBefore === undefined) return undefined
  const got = freeBuy - dec(s.buyBefore)
  return got > 0n ? got : undefined
}

// another swap changed the free balance of `token` by `by`
function rebase(s: SettledSwap, token: Instrument, by: Dec) {
  if (s.sellBefore !== undefined && sameInstrument(s.sell, token)) s.sellBefore = show(dec(s.sellBefore) + by)
  if (s.buyBefore !== undefined && sameInstrument(s.quoted, token)) s.buyBefore = show(dec(s.buyBefore) + by)
}

/** Swap `mover` changed the free balance of `token` by `by` (negative when it sold): the open swaps' baselines follow. */
export function moved<T extends SettledSwap>(records: T[], mover: string, token: Instrument, by: Dec): T[] {
  return records.map((r) => {
    if (r.id === mover || !OPEN.includes(r.status)) return r
    const c = { ...r }
    rebase(c, token, by)
    return c
  })
}

/**
 * The open swaps (not confirmed by the wallet, or sent and not filled),
 * settled against the free balances now. After `watchMs` a swap is no longer
 * settled: its transfer can no longer be signed or taken, and its baselines
 * are too old to read anything into the balances. `live` names the swaps
 * someone is watching right now.
 */
export function settle<T extends SettledSwap>(
  records: T[],
  free: (i: Instrument) => Dec,
  now: number,
  watchMs: number,
  live: (id: string) => boolean = () => false,
): T[] {
  const next = records.map((r) => ({ ...r }))
  const busy = next.filter((r) => live(r.id)).flatMap((r) => [r.sell, r.quoted])
  const touches = (r: T, i: Instrument) => sameInstrument(r.sell, i) || sameInstrument(r.quoted, i)
  const open = next
    .filter((r) => OPEN.includes(r.status) && !live(r.id) && r.sellBefore !== undefined && r.buyBefore !== undefined)
    .sort((a, b) => a.at - b.at)
  const others = (r: T) => open.filter((o) => o !== r && o.status !== 'filled')
  for (const r of open) {
    // nobody is waiting for the wallet's answer any more
    if (r.status === 'sending') r.status = 'unconfirmed'
    if (now - r.at > watchMs || busy.some((i) => touches(r, i))) continue
    if (r.status === 'unconfirmed') {
      if (!sent(r, free(r.sell))) continue
      r.status = 'pending'
      for (const o of others(r)) rebase(o, r.sell, -dec(r.sell.amount))
    }
    const got = arrived(r, free(r.quoted))
    if (got === undefined) continue
    r.status = 'filled'
    r.received = show(got)
    for (const o of others(r)) rebase(o, r.quoted, got)
  }
  return next
}
