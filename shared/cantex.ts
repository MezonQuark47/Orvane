// Cantex's public API: tokens, pools, quotes and market data.
//
// Orvane swaps through Cantex Connect: the trader sends a standard Canton
// transfer of the sell token to Cantex's swap party, with the buy token as
// the memo, and Cantex fills it from its pools. These endpoints need no key
// and allow browser requests (CORS *), so the web app calls them directly.
// Shapes below are as the TestNet API returned them on 2026-11-20.

export interface Instrument {
  admin: string
  id: string
}

export interface Token extends Instrument {
  name: string
  symbol: string
  coingeckoId?: string
}

export interface PoolState {
  poolId: string
  contractId: string
  symbol: string
  feeRate: string
  price: string
  a: Instrument & { symbol: string }
  b: Instrument & { symbol: string }
  reserveA: string
  reserveB: string
  tvlCc: string
}

export interface Amount extends Instrument {
  amount: string
}

export interface QuoteHop {
  poolId: string
  contractId: string
  sell: Amount
  buy: Amount
  feeRate: string
  liquidityFee: string
  adminFee: string
}

export interface Quote {
  sell: Amount
  returned: Amount
  memo: string
  networkFee: Amount
  feePercentage: string
  tradePrice: string
  priceImpact: string
  poolPriceBefore: string
  poolPriceAfter: string
  /** NaN where the venue gives no estimate */
  estimatedSeconds: number
  hops: QuoteHop[]
  receivedAt: number
  /** whose pricing rules the quote follows; Cantex's when absent */
  model?: 'cantex' | 'oneswap'
}

/** Where swaps fill: Cantex Connect, or OneSwap on DevNet (shared/oneswap.ts). */
export interface SwapVenue {
  readonly name: string
  swapTokens(): Promise<Token[]>
  pools(): Promise<PoolState[]>
  policy(): Promise<ExchangePolicy>
  quote(sell: Instrument, buy: Instrument, sellAmount: string): Promise<Quote>
}

export interface ExchangePolicy {
  minConnectSwapCc: string
  minRecommendedCcBalance: string
  networkFee: Amount
}

export interface Ticker {
  symbol: string
  price: number
  at: number
  raw: Record<string, unknown>
}

const instrumentOf = (admin: string, id: string): Instrument => ({ admin, id })
const amountOf = (x: { amount: string; instrument_admin: string; instrument_id: string }): Amount => ({
  amount: x.amount,
  admin: x.instrument_admin,
  id: x.instrument_id,
})

export const sameInstrument = (a: Instrument, b: Instrument) => a.admin === b.admin && a.id === b.id

export class CantexApi implements SwapVenue {
  readonly name = 'Cantex'
  readonly base: string
  constructor(base: string) {
    this.base = base.replace(/\/$/, '')
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`)
    if (!res.ok) throw new Error(`Cantex ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }

  // The tokens Connect can swap.
  async swapTokens(): Promise<Token[]> {
    type Wire = { data: { tokens: Array<{ instrument_admin: string; instrument_id: string; instrument_name: string; instrument_symbol: string; coingecko_id?: string }> } }
    const r = await this.get<Wire>('/swap/info')
    return r.data.tokens.map((t) => ({ ...instrumentOf(t.instrument_admin, t.instrument_id), name: t.instrument_name, symbol: t.instrument_symbol, coingeckoId: t.coingecko_id }))
  }

  async pools(): Promise<PoolState[]> {
    type Side = { admin: string; id: string; symbol: string }
    type Wire = {
      data: {
        pools: Array<{ pool_id: string; contract_id: string; symbol: string; fee_rate: string; price: string; reserve_a: string; reserve_b: string; tvl_cc: string; token_a_instrument: Side; token_b_instrument: Side }>
      }
    }
    const r = await this.get<Wire>('/pools/state')
    return r.data.pools.map((p) => ({
      poolId: p.pool_id,
      contractId: p.contract_id,
      symbol: p.symbol,
      feeRate: p.fee_rate,
      price: p.price,
      a: p.token_a_instrument,
      b: p.token_b_instrument,
      reserveA: p.reserve_a,
      reserveB: p.reserve_b,
      tvlCc: p.tvl_cc,
    }))
  }

  async policy(): Promise<ExchangePolicy> {
    type Wire = { data: { fees: { transfer: { amount: string; instrument_admin: string; instrument_id: string } }; policy: { min_connect_swap_amount_size_cc: string; min_recommended_cc_balance: string } } }
    const r = await this.get<Wire>('/exchange/info')
    return {
      minConnectSwapCc: r.data.policy.min_connect_swap_amount_size_cc,
      minRecommendedCcBalance: r.data.policy.min_recommended_cc_balance,
      networkFee: amountOf(r.data.fees.transfer),
    }
  }

  async quote(sell: Instrument, buy: Instrument, sellAmount: string): Promise<Quote> {
    type A = { amount: string; instrument_admin: string; instrument_id: string }
    type Wire = {
      estimated_time_seconds: string
      fees: { fee_percentage: string; network_fee: A }
      memo: string
      pool_price_after_trade: string
      pool_price_before_trade: string
      pools: Array<{ pool_id: string; contract_id: string; sell: A; buy: A; fees: { fee_percentage: string; liquidity: A; admin: A } }>
      returned: A
      slippage: string
      trade_price: string
      sent: { sell_amount: string; sell_instrument_admin: string; sell_instrument_id: string }
    }
    const res = await fetch(`${this.base}/connect/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sellAmount, sellInstrumentId: sell.id, sellInstrumentAdmin: sell.admin, buyInstrumentId: buy.id, buyInstrumentAdmin: buy.admin }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(cantexError(text, res.status))
    const r = JSON.parse(text) as Wire
    return {
      sell: { amount: r.sent.sell_amount, admin: r.sent.sell_instrument_admin, id: r.sent.sell_instrument_id },
      returned: amountOf(r.returned),
      memo: r.memo,
      networkFee: amountOf(r.fees.network_fee),
      feePercentage: r.fees.fee_percentage,
      tradePrice: r.trade_price,
      priceImpact: r.slippage,
      poolPriceBefore: r.pool_price_before_trade,
      poolPriceAfter: r.pool_price_after_trade,
      estimatedSeconds: Number(r.estimated_time_seconds),
      hops: r.pools.map((p) => ({
        poolId: p.pool_id,
        contractId: p.contract_id,
        sell: amountOf(p.sell),
        buy: amountOf(p.buy),
        feeRate: p.fees.fee_percentage,
        liquidityFee: p.fees.liquidity.amount,
        adminFee: p.fees.admin.amount,
      })),
      receivedAt: Date.now(),
    }
  }
}

// Cantex errors come as JSON with a detail or message; keep the words.
function cantexError(body: string, status: number): string {
  try {
    const j = JSON.parse(body) as { detail?: unknown; message?: string; error?: string }
    const detail = typeof j.detail === 'string' ? j.detail : Array.isArray(j.detail) ? JSON.stringify(j.detail) : undefined
    return `Cantex: ${detail ?? j.message ?? j.error ?? body.slice(0, 200)}`
  } catch {
    return `Cantex quote failed (${status}): ${body.slice(0, 200)}`
  }
}

export interface Candle {
  start: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketHandlers {
  onTicker?: (t: Ticker) => void
  /** a snapshot replaces the series; an update adds or replaces bars */
  onCandles?: (symbol: string, period: number, bars: Candle[], snapshot: boolean) => void
}

// Live market data over Cantex's public websocket: tickers and candles.
// Answers pings, reconnects with backoff and re-subscribes; returns a
// function that closes it.
export function streamMarket(wsUrl: string, channels: string[], h: MarketHandlers): () => void {
  let ws: WebSocket | undefined
  let closed = false
  let delay = 1_000
  const open = () => {
    ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      delay = 1_000
      ws?.send(JSON.stringify({ op: 'subscribe', channels, limit: 200 }))
    }
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { op?: string; channel?: string; type?: string; data?: Record<string, unknown> }
        if (msg.op === 'ping') return ws?.send(JSON.stringify({ op: 'pong' }))
        const ticker = /^market\.(.+)\.ticker$/.exec(msg.channel ?? '')
        if (ticker) {
          const price = Number(msg.data?.price)
          if (Number.isFinite(price)) h.onTicker?.({ symbol: ticker[1], price, at: Number(msg.data?.ts) || Date.now(), raw: msg.data ?? {} })
          return
        }
        const candles = /^market\.(.+)\.candles\.(\d+)$/.exec(msg.channel ?? '')
        if (candles) {
          const raw = (msg.data?.bars ?? (msg.data?.bar ? [msg.data.bar] : [])) as Array<Record<string, string>>
          const bars = raw.map((b) => ({ start: Number(b.start_ts), open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume }))
          h.onCandles?.(candles[1], Number(candles[2]), bars, msg.type === 'snapshot')
        }
      } catch {
        /* ignore anything we do not understand */
      }
    }
    ws.onclose = () => {
      if (closed) return
      setTimeout(open, delay)
      delay = Math.min(delay * 2, 30_000)
    }
  }
  open()
  return () => {
    closed = true
    ws?.close()
  }
}
