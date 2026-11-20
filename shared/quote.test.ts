// Orvane's quote check against real Cantex TestNet quotes and pool states,
// captured together in fixtures/cantex-testnet.json.
//
//   node --test shared/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dec } from './decimal.ts'
import { checkQuote, deviationBps, guardFreshQuote, minimumOut } from './quote.ts'
import type { PoolState, Quote } from './cantex.ts'

type A = { amount: string; instrument_admin: string; instrument_id: string }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cantex-testnet.json', import.meta.url), 'utf8'))
const cc = { admin: 'DSO::1220f22a8b8f2d813c25b9a684dc4dd52b532a0174d8e73a13cdf2baabfff7518337', id: 'Amulet' }

// the same mapping CantexApi applies to the wire format
const pools: PoolState[] = fixture.pools.data.pools.map((p: Record<string, never>) => ({
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
const amount = (x: A) => ({ amount: x.amount, admin: x.instrument_admin, id: x.instrument_id })
const quote = (name: string): Quote => {
  const r = fixture.quotes[name]
  return {
    sell: { amount: r.sent.sell_amount, admin: r.sent.sell_instrument_admin, id: r.sent.sell_instrument_id },
    returned: amount(r.returned),
    memo: r.memo,
    networkFee: amount(r.fees.network_fee),
    feePercentage: r.fees.fee_percentage,
    tradePrice: r.trade_price,
    priceImpact: r.slippage,
    poolPriceBefore: r.pool_price_before_trade,
    poolPriceAfter: r.pool_price_after_trade,
    estimatedSeconds: Number(r.estimated_time_seconds),
    hops: r.pools.map((h: { pool_id: string; contract_id: string; sell: A; buy: A; fees: { fee_percentage: string; liquidity: A; admin: A } }) => ({
      poolId: h.pool_id,
      contractId: h.contract_id,
      sell: amount(h.sell),
      buy: amount(h.buy),
      feeRate: h.fees.fee_percentage,
      liquidityFee: h.fees.liquidity.amount,
      adminFee: h.fees.admin.amount,
    })),
    receivedAt: 0,
  }
}

for (const name of ['CC->USDCx', 'USDCx->CC', 'CC->CBTC', 'USDCx->CBTC']) {
  test(`our own pricing agrees with Cantex: ${name}`, () => {
    const c = checkQuote(quote(name), pools, cc)
    assert.ok(c.agrees, `expected ${c.expected}, Cantex ${c.quoted}, off by ${c.diffBps} bps`)
  })
}

test('a two-hop route is checked hop by hop', () => {
  const c = checkQuote(quote('USDCx->CBTC'), pools, cc)
  assert.equal(c.hops.length, 2)
  assert.equal(c.hops[0].amountOut, c.hops[1].amountIn)
})

test('a quote that pays out more than the pools can is caught', () => {
  const q = quote('CC->USDCx')
  const inflated = { ...q, returned: { ...q.returned, amount: (Number(q.returned.amount) * 1.01).toFixed(10) } }
  assert.equal(checkQuote(inflated, pools, cc).agrees, false)
})

test('price impact is measured against spot', () => {
  // 100 CC into a 226 CC pool moves the price a lot
  assert.ok(checkQuote(quote('CC->USDCx'), pools, cc).priceImpactBps > 2_000)
})

test('the fresh-quote guard lets a small move through and stops a big one', () => {
  const seen = quote('CC->USDCx')
  const slightlyWorse = { ...seen, returned: { ...seen.returned, amount: (Number(seen.returned.amount) * 0.996).toFixed(10) } }
  const muchWorse = { ...seen, returned: { ...seen.returned, amount: (Number(seen.returned.amount) * 0.98).toFixed(10) } }
  assert.deepEqual(guardFreshQuote(seen, slightlyWorse, 50), { ok: true })
  assert.equal(guardFreshQuote(seen, muchWorse, 50).ok, false)
  assert.equal(guardFreshQuote(seen, { ...seen, sell: { ...seen.sell, amount: '101' } }, 50).ok, false)
})

test('minimum out rounds down', () => {
  assert.equal(minimumOut(dec('1.0000000000'), 100), dec('0.99'))
})

test('deviation from a reference price', () => {
  assert.equal(deviationBps(0.00078, 0.0762), 9898)
  assert.equal(deviationBps(1, 1), 0)
})
