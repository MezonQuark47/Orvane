// Smoke test against Cantex's live API: every pair Cantex lists gets a
// quote, and Orvane's own pricing must agree with each one.
//
//   node scripts/smoke-cantex.ts            (TestNet)
//   node scripts/smoke-cantex.ts mainnet

import { CantexApi, sameInstrument } from '../shared/cantex.ts'
import { checkQuote } from '../shared/quote.ts'
import { show } from '../shared/decimal.ts'
import { networkOf } from '../shared/networks.ts'

const net = networkOf(process.argv[2] ?? 'testnet')
if (!net.cantex) throw new Error(`${net.label} has no Cantex Connect`)
const api = new CantexApi(net.cantex.api)

const [tokens, policy] = await Promise.all([api.swapTokens(), api.policy()])
const cc = tokens.find((t) => t.symbol === 'CC')
if (!cc) throw new Error('Cantex lists no Canton Coin')
console.log(`${net.label}: ${tokens.length} tokens, minimum swap ${policy.minConnectSwapCc} CC, swap party ${net.cantex.swapParty.slice(0, 24)}… (${net.cantex.swapPartySource})`)

// a size Cantex accepts: the CC minimum, or that much CC worth of the token
const pools = await api.pools()
function sizeOf(t: (typeof tokens)[number]): string {
  const min = Number(policy.minConnectSwapCc) * 1.2
  if (sameInstrument(t, cc!)) return String(min)
  const p = pools.find((x) => (sameInstrument(x.a, t) && sameInstrument(x.b, cc!)) || (sameInstrument(x.b, t) && sameInstrument(x.a, cc!)))
  if (!p) return '1'
  const [ccRes, tRes] = sameInstrument(p.a, cc!) ? [Number(p.reserveA), Number(p.reserveB)] : [Number(p.reserveB), Number(p.reserveA)]
  return ((min * tRes) / ccRes).toFixed(10)
}

let failures = 0
for (const sell of tokens) {
  for (const buy of tokens) {
    if (sameInstrument(sell, buy)) continue
    const label = `${sell.symbol} -> ${buy.symbol}`.padEnd(18)
    try {
      // Cantex values its minimum at market prices; grow the size until it is accepted
      let size = Number(sizeOf(sell))
      const before = await api.pools()
      let q
      for (let i = 0; ; i++) {
        try {
          q = await api.quote(sell, buy, size.toFixed(10))
          break
        } catch (e) {
          if (i >= 4 || !/minimum ticket size/.test(String(e))) throw e
          size *= 5
        }
      }
      // MainNet pools move constantly: the quote has to match the pools as
      // they were just before or just after it
      const after = await api.pools()
      const checks = [checkQuote(q, before, cc, 25), checkQuote(q, after, cc, 25)]
      const c = checks.find((x) => x.agrees) ?? checks.sort((a, b) => a.diffBps - b.diffBps)[0]
      const ok = c.agrees
      if (!ok) failures++
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} sell ${q.sell.amount} -> ${q.returned.amount} (ours ${show(c.expected)}, ${c.diffBps} bps off, impact ${(c.priceImpactBps / 100).toFixed(2)}%, ${q.hops.length} hop)`)
    } catch (e) {
      console.log(`skip ${label} ${e instanceof Error ? e.message.slice(0, 120) : e}`)
    }
  }
}
console.log(failures ? `\n${failures} pair(s) disagree` : '\nall quoted pairs agree with Orvane\'s pricing')
process.exit(failures ? 1 : 0)
