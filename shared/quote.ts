// Orvane's own check of a Cantex quote.
//
// Cantex fills a Connect swap at the pool price when the transfer arrives,
// and its quote is not binding. So before a user signs, Orvane recomputes
// the expected output itself from the pools' public reserves and compares
// it with what Cantex says, then re-quotes right before signing and refuses
// to send if the price moved past the user's limit.
//
// Cantex's pricing, as reproduced from its TestNet quotes (2026-11-20):
//   - every hop is constant product, after that pool's fee: out = rOut*in'/(rIn+in'), in' = in*(1-fee)
//   - selling Canton Coin: the Connect fee and the network fee come off the input first
//   - buying Canton Coin: they come off the output
//   - a route that only passes through Canton Coin carries neither in the quote

import { ZERO, abs, dec, div, mul, show, sum, type Dec } from './decimal.ts'
import { sameInstrument, type Instrument, type PoolState, type Quote } from './cantex.ts'

const BPS = 10_000n

export interface HopCheck {
  poolId: string
  symbol: string
  amountIn: Dec
  amountOut: Dec
  spotPrice: Dec
}

export interface QuoteCheck {
  /** what Orvane computes from the public reserves */
  expected: Dec
  /** what Cantex quoted */
  quoted: Dec
  /** |expected - quoted| / quoted, in basis points */
  diffBps: number
  agrees: boolean
  /** the output lost to the trade's own size, against the pools' spot prices */
  priceImpactBps: number
  connectFee: Dec
  hops: HopCheck[]
}

const cp = (amountIn: Dec, reserveIn: Dec, reserveOut: Dec) => div(mul(reserveOut, amountIn), reserveIn + amountIn)

export function checkQuote(q: Quote, pools: PoolState[], cc: Instrument, toleranceBps = 5): QuoteCheck {
  const x = dec(q.sell.amount)
  const network = sameInstrument(q.networkFee, cc) ? dec(q.networkFee.amount) : ZERO
  const connect = dec(q.feePercentage) - sum(q.hops.map((h) => dec(h.feeRate)))
  const sellsCc = sameInstrument(q.sell, cc)
  const buysCc = sameInstrument(q.returned, cc)

  // Walk the route. `feesAtCc` charges the Connect and network fee where the
  // route passes through Canton Coin; Cantex's quotes for such routes have
  // been seen both with and without it, so both readings are computed.
  const walk = (feesAtCc: boolean) => {
    let amount = x
    let ideal = x
    const hops: HopCheck[] = []
    q.hops.forEach((h, i) => {
      const pool = pools.find((p) => p.poolId === h.poolId)
      if (!pool) throw new Error(`pool ${h.poolId} is not in Cantex's pool list`)
      const fromA = sameInstrument(h.sell, pool.a)
      const [rIn, rOut] = fromA ? [dec(pool.reserveA), dec(pool.reserveB)] : [dec(pool.reserveB), dec(pool.reserveA)]
      const fee = dec(h.feeRate)
      let effective = amount - mul(amount, fee)
      if (i === 0 && sellsCc) effective = effective - mul(amount, connect) - network
      else if (i > 0 && feesAtCc && sameInstrument(h.sell, cc)) effective = effective - mul(amount, connect) - network
      const out = cp(effective, rIn, rOut)
      const spot = div(rOut, rIn)
      hops.push({ poolId: h.poolId, symbol: pool.symbol, amountIn: amount, amountOut: out, spotPrice: spot })
      ideal = mul(ideal, spot)
      amount = out
    })
    if (buysCc) amount = amount - mul(amount, connect) - network
    return { amount, ideal, hops }
  }

  const quoted = dec(q.returned.amount)
  const plain = walk(false)
  const passesCc = !sellsCc && !buysCc && q.hops.slice(1).some((h) => sameInstrument(h.sell, cc))
  const charged = passesCc ? walk(true) : plain
  const bps = (a: Dec) => (quoted > ZERO ? Number((abs(a - quoted) * BPS) / quoted) : Number.POSITIVE_INFINITY)
  // inside the band between the two readings counts as agreeing
  const inBand = passesCc && quoted <= plain.amount && quoted >= charged.amount
  const best = bps(plain.amount) <= bps(charged.amount) ? plain : charged
  const diffBps = inBand ? 0 : Math.min(bps(plain.amount), bps(charged.amount))
  const priceImpactBps = best.ideal > ZERO ? Math.max(0, Number(((best.ideal - best.amount) * BPS) / best.ideal)) : 0
  return { expected: best.amount, quoted, diffBps, agrees: diffBps <= toleranceBps, priceImpactBps, connectFee: connect, hops: best.hops }
}

export type Guard = { ok: true } | { ok: false; reason: string }

// Right before signing: the fresh quote must still give at least the
// minimum the user accepted from the quote they saw.
export function guardFreshQuote(seen: Quote, fresh: Quote, slippageBps: number): Guard {
  if (!sameInstrument(seen.sell, fresh.sell) || !sameInstrument(seen.returned, fresh.returned) || seen.sell.amount !== fresh.sell.amount) {
    return { ok: false, reason: 'The order changed; quote again.' }
  }
  const floor = minimumOut(dec(seen.returned.amount), slippageBps)
  const now = dec(fresh.returned.amount)
  if (now < floor) {
    return { ok: false, reason: `The price moved: you would now get ${show(now)} instead of at least ${show(floor)}. Nothing was sent.` }
  }
  return { ok: true }
}

export const minimumOut = (amount: Dec, slippageBps: number) => (amount * BigInt(10_000 - slippageBps)) / BPS

// How far the pool's own price sits from an outside reference price (for
// example Canton Coin's market price), in basis points. A big gap means the
// pool is mispriced and the trade is likely a bad one.
export function deviationBps(poolPrice: number, referencePrice: number): number {
  if (!(poolPrice > 0) || !(referencePrice > 0)) return 0
  return Math.round((Math.abs(poolPrice - referencePrice) / referencePrice) * 10_000)
}
