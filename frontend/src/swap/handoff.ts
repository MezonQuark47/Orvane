// A pair picked on another page (a pool row on Markets) for the swap page to
// open with. Held in memory only, and taken once: a reload starts from the
// swap page's own default pair.

import type { Instrument } from '../../../shared/cantex.ts'

let pending: [Instrument, Instrument] | undefined

export function openPair(sell: Instrument, buy: Instrument) {
  pending = [sell, buy]
}

export function takePair() {
  const p = pending
  pending = undefined
  return p
}
