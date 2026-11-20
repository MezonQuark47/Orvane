// The operator's HTTP API for the web app.
//
// It serves what any AMM publishes (pool terms, reserves, prices, quotes)
// and proxies the registries' off-ledger API. It never returns positions,
// receipts or anyone's party id: those live only on the owners' nodes.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dec, show, type Dec } from '../shared/decimal.ts'
import { DEX, poolSettlement, quote, sameInstrument, type PoolState, type SwapReceipt } from '../shared/dex.ts'
import type { AllocationAction, TransferAction } from '../shared/registry.ts'
import type { Network } from './network.ts'

const HISTORY = 50

async function body<T>(req: IncomingMessage): Promise<T> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return (raw ? JSON.parse(raw) : {}) as T
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function poolStates(net: Network) {
  const states = await net.ledger.query<PoolState>(net.operator, [DEX.PoolState])
  return new Map(states.map((s) => [s.payload.poolId, s.payload]))
}

// Recent fills as (time, price of A in B, size in A): enough for a chart,
// with nothing about who traded.
async function recentPrices(net: Network) {
  const receipts = await net.ledger.query<SwapReceipt>(net.operator, [DEX.SwapReceipt])
  const byPool = new Map<string, Array<{ at: string; price: number; sizeA: number }>>()
  for (const { payload: r } of receipts) {
    const pool = net.pools.get(r.poolId)
    if (!pool) continue
    const sellsA = sameInstrument(r.instrumentIn, pool.terms.instrumentA)
    const a = sellsA ? +r.amountIn : +r.amountOut
    const b = sellsA ? +r.amountOut : +r.amountIn
    const list = byPool.get(r.poolId) ?? []
    list.push({ at: r.settledAt, price: b / a, sizeA: a })
    byPool.set(r.poolId, list)
  }
  for (const list of byPool.values()) list.sort((x, y) => x.at.localeCompare(y.at)).splice(0, Math.max(0, list.length - HISTORY))
  return byPool
}

async function handle(net: Network, req: IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/config') {
    return {
      network: net.cfg.network,
      operator: net.operator,
      instruments: Object.fromEntries(Object.entries(net.instruments).map(([k, i]) => [k, { ...i, label: net.labels[k] }])),
      pools: [...net.pools.values()].map(({ terms, desk }) => ({ ...terms, settlement: poolSettlement(net.operator, terms.poolId), desk })),
    }
  }

  if (req.method === 'GET' && path === '/api/pools') {
    const [states, prices] = await Promise.all([poolStates(net), recentPrices(net)])
    return [...net.pools.values()].map(({ terms }) => {
      const s = states.get(terms.poolId)
      return {
        poolId: terms.poolId,
        reserveA: s?.reserveA ?? '0.0000000000',
        reserveB: s?.reserveB ?? '0.0000000000',
        positions: Number(s?.positions ?? 0),
        status: s?.status ?? 'Active',
        swaps: Number(s?.swaps ?? 0),
        recent: prices.get(terms.poolId) ?? [],
      }
    })
  }

  if (req.method === 'POST' && path === '/api/quote') {
    const q = await body<{ poolId: string; sell: 'A' | 'B'; amountIn: string }>(req)
    const pool = net.pools.get(q.poolId)
    if (!pool) throw new HttpError(404, 'unknown pool')
    let amountIn: Dec
    try {
      amountIn = dec(q.amountIn)
    } catch {
      throw new HttpError(400, 'amountIn must be a decimal with at most 10 places')
    }
    if (amountIn <= 0n) throw new HttpError(400, 'amountIn must be positive')
    const s = (await poolStates(net)).get(q.poolId)
    if (!s || s.positions === '0') throw new HttpError(409, 'the pool has no liquidity yet')
    const [reserveIn, reserveOut] = q.sell === 'A' ? [dec(s.reserveA), dec(s.reserveB)] : [dec(s.reserveB), dec(s.reserveA)]
    const r = quote({ feeBps: pool.terms.feeBps, reserveIn, reserveOut }, amountIn)
    return {
      amountOut: show(r.amountOut),
      spotPrice: show(r.spotPrice),
      tradePrice: show(r.tradePrice),
      priceImpactBps: r.priceImpactBps,
      feeBps: pool.terms.feeBps,
    }
  }

  // /api/registry/<admin>/<operation>[/<id>/<action>]
  const m = /^\/api\/registry\/([^/]+)\/(.+)$/.exec(path)
  if (req.method === 'POST' && m) {
    const admin = decodeURIComponent(m[1])
    if (!net.registries.has(admin)) throw new HttpError(404, 'unknown registry')
    const reg = net.registries.for(admin)
    const rest = m[2].split('/').map(decodeURIComponent)
    const args = await body<{ choiceArguments?: unknown }>(req)
    if (rest[0] === 'allocation-factory') return reg.allocationFactory(args.choiceArguments)
    if (rest[0] === 'transfer-factory') return reg.transferFactory(args.choiceArguments)
    // Owners withdraw their allocations; cancelling is the executor's job and
    // stays inside the operator, as does settlement.
    if (rest[0] === 'allocations' && rest.length === 3 && rest[2] === 'withdraw') return reg.allocationChoice(rest[1], 'withdraw' satisfies AllocationAction)
    if (rest[0] === 'transfers' && rest.length === 3 && ['accept', 'reject', 'withdraw'].includes(rest[2])) {
      return reg.transferChoice(rest[1], rest[2] as TransferAction)
    }
  }

  throw new HttpError(404, 'not found')
}

export function serve(net: Network, port: number) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    try {
      send(200, await handle(net, req))
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message })
      net.log('api error', req.method, req.url, err instanceof Error ? err.message : err)
      send(502, { error: err instanceof Error ? err.message : String(err) })
    }
  })
  server.listen(port, () => net.log(`operator api on http://localhost:${port}`))
  return server
}
