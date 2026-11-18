// Orvane operator service for the local sandbox.
//
//  1. Bootstraps a demo world (parties, USDx/CCx pool, seed liquidity).
//  2. Settles SwapRequests and liquidity requests as they arrive.
//  3. Serves a tiny HTTP API for the web app: /api/config and /api/faucet.
//
// The operator only exposes public configuration. It never returns what it
// can see on the ledger, so the privacy guarantees hold for the web app too.

import { createServer } from 'node:http'
import { JsonLedger, LedgerError, createdOf, type Contract } from '../shared/ledger.ts'
import {
  T,
  dec,
  exercise,
  placeLiquidity,
  type AddLiquidityRequest,
  type Pool,
  type RemoveLiquidityRequest,
  type SwapRequest,
  type Token,
} from '../shared/amm.ts'

const LEDGER_URL = process.env.LEDGER_URL ?? 'http://localhost:6864'
const PORT = Number(process.env.OPERATOR_PORT ?? 7600)
const POOL_ID = 'USDx-CCx'
const FEE_BPS = 30
const TICK_MS = 700

const ledger = new JsonLedger(LEDGER_URL)
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args)

type Parties = Record<'operator' | 'usdIssuer' | 'ccIssuer' | 'alice' | 'bob' | 'carol', string>

const HINTS: Record<keyof Parties, string> = {
  operator: 'Operator',
  usdIssuer: 'UsdIssuer',
  ccIssuer: 'CcIssuer',
  alice: 'Alice',
  bob: 'Bob',
  carol: 'Carol',
}

async function ensureParties(): Promise<Parties> {
  const existing = await ledger.listParties()
  const out = {} as Parties
  for (const [key, hint] of Object.entries(HINTS) as Array<[keyof Parties, string]>) {
    out[key] = existing.find((p) => p.startsWith(`${hint}::`)) ?? (await ledger.allocateParty(hint))
  }
  return out
}

async function mint(issuer: string, owner: string, symbol: string, amount: number) {
  await ledger.submit([issuer], [
    { CreateCommand: { templateId: T.Token, createArguments: { issuer, owner, symbol, amount: dec(amount), observers: [] } } },
  ])
}

async function findPool(p: Parties): Promise<Contract<Pool> | undefined> {
  const pools = await ledger.query<Pool>(p.operator, [T.Pool])
  return pools.find((c) => c.payload.poolId === POOL_ID)
}

async function holdingsOf(owner: string, issuer: string, symbol: string) {
  const tokens = await ledger.query<Token>(owner, [T.Token])
  return tokens.filter((t) => t.payload.owner === owner && t.payload.issuer === issuer && t.payload.symbol === symbol)
}

async function fundTrader(p: Parties, who: string, usd: number, cc: number) {
  await mint(p.usdIssuer, who, 'USDx', usd)
  await mint(p.ccIssuer, who, 'CCx', cc)
}

async function bootstrap(): Promise<Parties> {
  const p = await ensureParties()
  if (await findPool(p)) {
    log('pool already exists, skipping seed')
    return p
  }
  log('creating pool', POOL_ID)
  await ledger.submit([p.operator], [
    {
      CreateCommand: {
        templateId: T.Pool,
        createArguments: {
          operator: p.operator,
          poolId: POOL_ID,
          issuerA: p.usdIssuer,
          symbolA: 'USDx',
          issuerB: p.ccIssuer,
          symbolB: 'CCx',
          reserveA: dec(0),
          reserveB: dec(0),
          holdingA: null,
          holdingB: null,
          totalShares: dec(0),
          feeBps: dec(FEE_BPS),
          members: [p.alice, p.bob, p.carol],
        },
      },
    },
  ])

  // Alice seeds the pool at 0.20 USDx per CCx.
  await fundTrader(p, p.alice, 250_000, 1_250_000)
  const usd = await holdingsOf(p.alice, p.usdIssuer, 'USDx')
  const cc = await holdingsOf(p.alice, p.ccIssuer, 'CCx')
  await ledger.submit([p.alice], [
    placeLiquidity({
      provider: p.alice,
      operator: p.operator,
      poolId: POOL_ID,
      holdingsA: usd.map((t) => t.contractId),
      amountA: 200_000,
      holdingsB: cc.map((t) => t.contractId),
      amountB: 1_000_000,
      minShares: 0,
    }),
  ])
  await settleOnce(p)

  await fundTrader(p, p.bob, 25_000, 60_000)
  await fundTrader(p, p.carol, 8_000, 30_000)
  log('demo world ready')
  return p
}

// ---------- settlement ----------

async function settleOnce(p: Parties) {
  const requests = await ledger.query<SwapRequest | AddLiquidityRequest | RemoveLiquidityRequest>(p.operator, [
    T.SwapRequest,
    T.AddLiquidityRequest,
    T.RemoveLiquidityRequest,
  ])
  for (const req of requests) {
    if (failed.has(req.contractId)) continue
    const pool = await findPool(p)
    if (!pool) return
    const kind = req.templateId.split(':').pop()!
    const execChoice = `${kind}_Execute`
    const templateId = (T as Record<string, string>)[kind]
    try {
      const tx = await ledger.submit([p.operator], [exercise(templateId, req.contractId, execChoice, { poolCid: pool.contractId })])
      const receipt = createdOf(tx, T.SwapReceipt)
      if (receipt) {
        const r = receipt.createArgument as { symbolIn: string; amountIn: string; symbolOut: string; amountOut: string }
        log(`settled swap ${(+r.amountIn).toFixed(2)} ${r.symbolIn} -> ${(+r.amountOut).toFixed(4)} ${r.symbolOut}`)
      } else {
        log(`settled ${kind}`)
      }
    } catch (err) {
      const reason = err instanceof LedgerError ? err.message : String(err)
      log(`rejecting ${kind}: ${reason}`)
      const rejectChoice = kind === 'SwapRequest' ? 'SwapRequest_Reject' : undefined
      try {
        if (rejectChoice) {
          await ledger.submit([p.operator], [exercise(templateId, req.contractId, rejectChoice, { reason })])
        } else {
          // Liquidity requests have no operator-side reject: leave them for the
          // provider to cancel, but don't retry forever.
          failed.add(req.contractId)
        }
      } catch (e) {
        log('reject failed', e instanceof Error ? e.message : e)
      }
    }
  }
}

const failed = new Set<string>()

async function settleLoop(p: Parties) {
  for (;;) {
    try {
      await settleOnce(p)
    } catch (err) {
      log('settle error', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, TICK_MS))
  }
}

// ---------- http ----------

function serve(p: Parties) {
  const lastDrip = new Map<string, number>()
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method === 'GET' && req.url === '/api/config') {
        return send(200, {
          poolId: POOL_ID,
          operator: p.operator,
          issuers: { USDx: p.usdIssuer, CCx: p.ccIssuer },
          personas: [
            { key: 'alice', name: 'Alice', role: 'Liquidity provider', party: p.alice },
            { key: 'bob', name: 'Bob', role: 'Trader', party: p.bob },
            { key: 'carol', name: 'Carol', role: 'Pool member', party: p.carol },
          ],
        })
      }
      if (req.method === 'POST' && req.url === '/api/faucet') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const { party } = JSON.parse(raw || '{}') as { party?: string }
        if (!party || ![p.alice, p.bob, p.carol].includes(party)) return send(400, { error: 'unknown party' })
        const now = Date.now()
        if (now - (lastDrip.get(party) ?? 0) < 5_000) return send(429, { error: 'slow down' })
        lastDrip.set(party, now)
        await fundTrader(p, party, 1_000, 5_000)
        return send(200, { ok: true, minted: { USDx: 1000, CCx: 5000 } })
      }
      send(404, { error: 'not found' })
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) })
    }
  })
  server.listen(PORT, () => log(`operator api on http://localhost:${PORT}`))
}

async function waitForLedger() {
  for (let i = 0; ; i++) {
    try {
      await ledger.ledgerEnd()
      return
    } catch {
      if (i === 0) log(`waiting for ledger at ${LEDGER_URL} ...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

await waitForLedger()
const parties = await bootstrap()
serve(parties)
void settleLoop(parties)
