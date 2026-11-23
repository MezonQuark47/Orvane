// OneSwap, the swap venue on DevNet, where Cantex does not run.
//
// OneSwap's pools are constant product with a fee on the input. A swap is an
// order opened first (with the integrator key, so through Orvane's own
// forwarder, api/oneswap.ts): OneSwap answers with a deposit party, the
// user's wallet sends the input there as a plain transfer, OneSwap swaps it
// and sends the output back to the party that paid. Unlike Cantex it enforces
// a minimum output, and it refunds a swap it cannot fill.
//
// Shapes below are as OneSwap's DevNet API returned them on 2026-11-23
// (`@oneswap/sdk` 1.4.0 describes the same endpoints).

import { dec, show } from './decimal.ts'
import { sameInstrument, type ExchangePolicy, type Instrument, type PoolState, type Quote, type SwapVenue, type Token } from './cantex.ts'

interface Asset {
  symbol: string
  admin: string
  id: string
}

interface WirePool {
  id: string
  name: string | null
  assetX: Asset
  assetY: Asset
  reserveX: number
  reserveY: number
  feeBps: number
  visible?: boolean
  swapsEnabled?: boolean
  primary?: boolean
  /** input of swaps in flight; OneSwap prices against the reserves less these */
  accounting?: { reservedX?: string; reservedY?: string }
}

interface WireQuote {
  amountOut: number
  networkFeeIn: number
  effFeeBps: number
  priceImpactPct: number
}

export type OneSwapStatus = 'awaiting_deposit' | 'deposit_detected' | 'swapping' | 'recovering' | 'needs_review' | 'returned' | 'refunded' | 'expired' | 'failed' | 'cancelled'

export interface OneSwapOrder {
  id: string
  status: OneSwapStatus
  poolId: string
  amountIn: number
  minOut: number | null
  /** where the user's wallet sends the input */
  depositParty: string
  deadline: string
  amountOut?: number | null
  error?: string | null
}

export const TERMINAL: OneSwapStatus[] = ['returned', 'refunded', 'expired', 'failed', 'cancelled']

/** OneSwap answered with an error. `status` 409 with an open swap means the user already has one in flight. */
export class OneSwapError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// a number as a Daml decimal string (10 places), never in exponent form
const num = (n: number) => show(dec(n.toFixed(10)))

// OneSwap prices against the reserves less the input of swaps in flight
const reserves = (p: WirePool): [number, number] => [p.reserveX - Number(p.accounting?.reservedX ?? 0), p.reserveY - Number(p.accounting?.reservedY ?? 0)]

export class OneSwapApi implements SwapVenue {
  readonly name = 'OneSwap'
  readonly base: string
  constructor(base: string) {
    this.base = base.replace(/\/$/, '')
  }

  // every call goes through Orvane's forwarder, which passes `path` on to OneSwap
  private async call<T>(path: string, body?: unknown, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ path, ...params })
    const res = await fetch(`${this.base}?${qs}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 200)
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message
      } catch {
        /* not JSON */
      }
      throw new OneSwapError(res.status, `OneSwap: ${message}`)
    }
    return JSON.parse(text) as T
  }

  // The pools a swap can use: open, with liquidity, and the deepest one per
  // pair (DevNet has a small test pool next to the real CC/CBTC one).
  private async tradable(): Promise<WirePool[]> {
    const all = await this.call<WirePool[]>('/api/rt/pools')
    const open = all.filter((p) => p.visible !== false && p.swapsEnabled !== false && p.reserveX > 0 && p.reserveY > 0)
    const best = new Map<string, WirePool>()
    for (const p of open) {
      const pair = [p.assetX, p.assetY].map((a) => `${a.admin}|${a.id}`).sort().join('/')
      const cur = best.get(pair)
      if (!cur || p.primary || (!cur.primary && p.reserveX > cur.reserveX)) best.set(pair, p)
    }
    return [...best.values()]
  }

  async swapTokens(): Promise<Token[]> {
    const seen = new Map<string, Token>()
    for (const p of await this.tradable()) {
      for (const a of [p.assetX, p.assetY]) seen.set(`${a.admin}|${a.id}`, { admin: a.admin, id: a.id, symbol: a.symbol, name: a.id === 'Amulet' ? 'Canton Coin' : a.symbol })
    }
    return [...seen.values()]
  }

  async pools(): Promise<PoolState[]> {
    return (await this.tradable()).map((p) => {
      const [x, y] = reserves(p)
      const ccSide = p.assetX.id === 'Amulet' ? x : p.assetY.id === 'Amulet' ? y : 0
      return {
        poolId: p.id,
        contractId: '',
        symbol: `${p.assetX.symbol}-${p.assetY.symbol}`.toUpperCase(),
        feeRate: String(p.feeBps / 10_000),
        price: num(y / x),
        a: p.assetX,
        b: p.assetY,
        reserveA: num(x),
        reserveB: num(y),
        // the Canton Coin side, both ways; pools without Canton Coin are left at 0
        tvlCc: num(2 * ccSide),
      }
    })
  }

  // OneSwap sets no minimum in Canton Coin; its network fee comes with each quote
  async policy(): Promise<ExchangePolicy> {
    return { minConnectSwapCc: '0', minRecommendedCcBalance: '0', networkFee: { admin: '', id: 'Amulet', amount: '0' } }
  }

  async quote(sell: Instrument, buy: Instrument, sellAmount: string): Promise<Quote> {
    const pool = (await this.tradable()).find(
      (p) => (sameInstrument(p.assetX, sell) && sameInstrument(p.assetY, buy)) || (sameInstrument(p.assetX, buy) && sameInstrument(p.assetY, sell)),
    )
    if (!pool) throw new Error('OneSwap: no pool trades this pair directly')
    const xToY = sameInstrument(pool.assetX, sell)
    const q = await this.call<WireQuote>(`/api/rt/pool/${encodeURIComponent(pool.id)}/quote`, { amountIn: Number(sellAmount), xToY })
    const feeRate = String(q.effFeeBps / 10_000)
    return {
      sell: { ...sell, amount: sellAmount },
      returned: { ...buy, amount: num(q.amountOut) },
      memo: '',
      networkFee: { ...sell, amount: num(q.networkFeeIn) },
      feePercentage: feeRate,
      tradePrice: num(q.amountOut / Number(sellAmount)),
      priceImpact: String(q.priceImpactPct / 100),
      poolPriceBefore: '',
      poolPriceAfter: '',
      estimatedSeconds: Number.NaN,
      hops: [{ poolId: pool.id, contractId: '', sell: { ...sell, amount: sellAmount }, buy: { ...buy, amount: num(q.amountOut) }, feeRate, liquidityFee: '0', adminFee: '0' }],
      receivedAt: Date.now(),
      model: 'oneswap',
    }
  }

  /** Opens a swap. The user's wallet then sends `amountIn` of `inSymbol` to the order's deposit party. */
  createSwap(args: { userRef: string; inSymbol: string; amountIn: number; outSymbol: string; poolId: string; minOut: number }): Promise<OneSwapOrder> {
    return this.call<OneSwapOrder>('/api/sdk/escrow/swap', args)
  }

  /**
   * Opens the swap a quote describes, held to `minOut`. OneSwap keeps one open
   * swap per user; an earlier one is never cancelled here, since its deposit
   * may still be on the way.
   */
  async order(userRef: string, q: Quote, minOut: string): Promise<OneSwapOrder> {
    const pool = (await this.tradable()).find((p) => p.id === q.hops[0]?.poolId)
    if (!pool) throw new Error('OneSwap: the pool for this quote is gone')
    const symbol = (i: Instrument) => (sameInstrument(pool.assetX, i) ? pool.assetX : pool.assetY).symbol
    const args = { userRef, inSymbol: symbol(q.sell), amountIn: Number(q.sell.amount), outSymbol: symbol(q.returned), poolId: pool.id, minOut: Number(minOut) }
    try {
      return await this.createSwap(args)
    } catch (e) {
      if (!(e instanceof OneSwapError) || e.status !== 409) throw e
      const open = await this.openSwap(userRef).catch(() => null)
      const until = open?.deadline ? ` (it waits for its deposit until ${new Date(open.deadline).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : ''
      throw new OneSwapError(409, `OneSwap still has your previous swap open${until}. Try again once it is done.`)
    }
  }

  getSwap(id: string): Promise<OneSwapOrder> {
    return this.call<OneSwapOrder>(`/api/sdk/escrow/swap/${encodeURIComponent(id)}`)
  }

  async openSwap(userRef: string): Promise<OneSwapOrder | null> {
    return (await this.call<{ swap?: OneSwapOrder | null }>('/api/sdk/escrow/open-swap', undefined, { userRef })).swap ?? null
  }

  /** Only a swap still waiting for its deposit can be cancelled. */
  cancel(id: string): Promise<OneSwapOrder> {
    return this.call<OneSwapOrder>(`/api/sdk/escrow/swap/${encodeURIComponent(id)}/cancel`, {})
  }
}
