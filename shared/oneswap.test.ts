import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OneSwapApi } from './oneswap.ts'
import { checkQuote } from './quote.ts'

const CC = { symbol: 'CC', admin: 'DSO::1220be', id: 'Amulet' }
const CBTC = { symbol: 'CBTC', admin: 'cbtc-network::12202a', id: 'CBTC' }

// OneSwap's DevNet pools and a quote for 1,000 CC, as its API returned them on 2026-11-23
const POOLS = [
  {
    id: 'rt-pgfzng',
    name: 'CC/CBTC',
    assetX: CC,
    assetY: CBTC,
    reserveX: 343931.334184796,
    reserveY: 1.2886832047,
    feeBps: 30,
    visible: true,
    accounting: { reservedX: '160.5361663545', reservedY: '0.0002166643' },
  },
  { id: 'rt-cpzi9s', name: 'xop-test', assetX: CC, assetY: CBTC, reserveX: 230.601242151, reserveY: 0.0000281832, feeBps: 30, visible: true },
  { id: 'rt-klxqzt', name: 'CC/HTEST', assetX: CC, assetY: { symbol: 'HTEST', admin: 'test-token-1::1220', id: 'HTEST' }, reserveX: 0, reserveY: 0, feeBps: 30, visible: true },
]
const QUOTE = { amountOut: 0.0037259893, priceImpactPct: 0.5883137119317428, networkFeeIn: 0, swapFeeBps: 30, effFeeBps: 30 }

async function oneswap(quote = QUOTE) {
  const seen: string[] = []
  const s = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const path = new URL(req.url ?? '', 'http://x').searchParams.get('path') ?? ''
    seen.push(`${req.method} ${path} ${body}`)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(path === '/api/rt/pools' ? POOLS : quote))
  })
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  const api = new OneSwapApi(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/oneswap`)
  return { api, seen, close: () => new Promise<void>((ok) => s.close(() => ok())) }
}

test('only pools with liquidity count, the deepest one per pair', async () => {
  const o = await oneswap()
  try {
    const pools = await o.api.pools()
    assert.deepEqual(
      pools.map((p) => p.poolId),
      ['rt-pgfzng'],
    )
    // priced against the reserves less the swaps in flight
    assert.equal(pools[0].reserveA, '343770.7980184415')
    assert.deepEqual(
      (await o.api.swapTokens()).map((t) => t.symbol),
      ['CC', 'CBTC'],
    )
  } finally {
    await o.close()
  }
})

test("OneSwap's DevNet quote matches Orvane's own pricing", async () => {
  const o = await oneswap()
  try {
    const q = await o.api.quote(CC, CBTC, '1000')
    assert.equal(q.model, 'oneswap')
    assert.equal(q.returned.amount, '0.0037259893')
    assert.ok(o.seen.some((s) => s.startsWith('POST /api/rt/pool/rt-pgfzng/quote {"amountIn":1000,"xToY":true}')))
    const c = checkQuote(q, await o.api.pools(), CC, 25)
    assert.equal(c.agrees, true, `off by ${c.diffBps} bps`)
  } finally {
    await o.close()
  }
})

test('the network fee comes off the input before the pool fee', async () => {
  // 1,000 CC with a 20 CC network fee: (1000 - 20) * 0.997 goes into the pool
  const [x, y] = [343931.334184796 - 160.5361663545, 1.2886832047 - 0.0002166643]
  const inPool = 980 * 0.997
  const out = (y * inPool) / (x + inPool)
  const o = await oneswap({ ...QUOTE, amountOut: Number(out.toFixed(10)), networkFeeIn: 20 })
  try {
    const q = await o.api.quote(CC, CBTC, '1000')
    assert.equal(checkQuote(q, await o.api.pools(), CC, 5).agrees, true)
  } finally {
    await o.close()
  }
})

test('a quote better than the pools allow does not pass', async () => {
  const o = await oneswap({ ...QUOTE, amountOut: 0.0038 })
  try {
    const q = await o.api.quote(CC, CBTC, '1000')
    assert.equal(checkQuote(q, await o.api.pools(), CC, 25).agrees, false)
  } finally {
    await o.close()
  }
})
