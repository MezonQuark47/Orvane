// Orvane operator service for the local sandbox.
//
//  1. Uploads the contracts and bootstraps a demo world: a USDx/CCx pool,
//     a company (Acme) with three employees, a supplier (Nova) and an auditor.
//  2. Settles requests as they arrive: swaps, liquidity, payroll conversions
//     and cross-currency invoice payments.
//  3. Serves a tiny HTTP API for the web app: /api/config and /api/faucet.
//
// The operator only exposes public configuration. It never returns what it
// can see on the ledger, so the privacy guarantees hold for the web app too.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { JsonLedger, LedgerError, createdOf, type Contract } from '../shared/ledger.ts'
import { T, dec, exercise, placeLiquidity, type Pool, type Token } from '../shared/amm.ts'
import { P, issueInvoice, setPreference } from '../shared/payments.ts'
import { bootstrapExchange, bootstrapPayroll, convertPayOnce, exchangeContext, fundTrader, settleExchangeOnce, EXCHANGE_POOL_ID, type ExchangeCtx } from './exchange.ts'
import { L, borrow, healthFactor, marketView, owedAt, supply, type LendingMarket, type Loan } from '../shared/lending.ts'

// ORVANE_NETWORK=sandbox (default): `dpm sandbox`, no auth.
// ORVANE_NETWORK=localnet: Splice LocalNet, app-provider participant, HS256 dev auth.
const NETWORKS = {
  sandbox: { url: 'http://localhost:6864', adminUser: 'participant_admin', appUser: 'orvane', auth: undefined },
  localnet: {
    url: 'http://localhost:3975',
    adminUser: 'ledger-api-user',
    appUser: 'orvane',
    auth: { secret: process.env.LOCALNET_AUTH_SECRET ?? 'unsafe', audience: 'https://canton.network.global' },
  },
} as const
const NETWORK_NAME = (process.env.ORVANE_NETWORK ?? (process.argv.includes('--localnet') ? 'localnet' : 'sandbox')) as keyof typeof NETWORKS
const NETWORK = NETWORKS[NETWORK_NAME]
if (!NETWORK) throw new Error(`unknown ORVANE_NETWORK "${process.env.ORVANE_NETWORK}"`)
const LEDGER_URL = process.env.LEDGER_URL ?? NETWORK.url
const PORT = Number(process.env.OPERATOR_PORT ?? 7600)
const POOL_ID = 'USDx-CCx'
const MARKET_ID = 'USDx-lend'
const DEMO_YEAR_SECONDS = 3600
const FEE_BPS = 30
const TICK_MS = 700

const DARS = [
  new URL('../daml/orvane-amm/.daml/dist/orvane-defi-amm-0.1.0.dar', import.meta.url),
  new URL('../daml/orvane-payments/.daml/dist/orvane-payments-0.1.0.dar', import.meta.url),
  new URL('../daml/orvane-lending/.daml/dist/orvane-lending-0.1.0.dar', import.meta.url),
  new URL('../daml/orvane-registry/.daml/dist/orvane-registry-0.1.0.dar', import.meta.url),
  new URL('../daml/orvane-exchange/.daml/dist/orvane-exchange-0.1.0.dar', import.meta.url),
  new URL('../daml/orvane-treasury/.daml/dist/orvane-treasury-0.1.0.dar', import.meta.url),
]

// Admin client (allocates parties, uploads DARs). On LocalNet every call is
// authenticated with a JWT; the sandbox has no auth.
const admin = new JsonLedger(LEDGER_URL, NETWORK.adminUser, NETWORK.auth)
// Client used for everything else; switches to the app user after bootstrap.
let ledger = admin
const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args)

const HINTS = {
  operator: 'Operator',
  usdIssuer: 'UsdIssuer',
  ccIssuer: 'CcIssuer',
  alice: 'Alice',
  bob: 'Bob',
  carol: 'Carol',
  acme: 'Acme',
  nova: 'Nova',
  auditor: 'Auditor',
} as const
type Parties = Record<keyof typeof HINTS, string>

const TEMPLATES: Record<string, string> = { ...T, ...P, ...L }

async function uploadDars() {
  for (const dar of DARS) {
    let bytes: Buffer
    try {
      bytes = await readFile(dar)
    } catch {
      throw new Error(`missing ${dar.pathname}. Run "dpm build --all" in daml/ first.`)
    }
    // Right after start-up the participant may not be connected to a
    // synchronizer yet; retry for a while.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.uploadDar(bytes)
        break
      } catch (err) {
        if (attempt >= 30) throw err
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
}

async function ensureParties(): Promise<Parties> {
  const existing = await admin.listParties()
  const out = {} as Parties
  for (const [key, hint] of Object.entries(HINTS) as Array<[keyof Parties, string]>) {
    out[key] = existing.find((p) => p.startsWith(`${hint}::`)) ?? (await admin.allocateParty(hint))
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

async function fund(p: Parties, who: string, usd: number, cc: number) {
  if (usd > 0) await mint(p.usdIssuer, who, 'USDx', usd)
  if (cc > 0) await mint(p.ccIssuer, who, 'CCx', cc)
}

const members = (p: Parties) => [p.alice, p.bob, p.carol, p.acme, p.nova]

async function bootstrapMarket(p: Parties) {
  const existing = await findPool(p)
  if (existing) {
    const missing = members(p).filter((m) => !existing.payload.members.includes(m))
    if (missing.length) {
      await ledger.submit([p.operator], [exercise(T.Pool, existing.contractId, 'Pool_SetMembers', { newMembers: members(p) })])
      log('pool members updated')
    }
    return
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
          members: members(p),
        },
      },
    },
  ])

  // Alice seeds the pool at 0.20 USDx per CCx.
  await fund(p, p.alice, 250_000, 1_250_000)
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
  await fund(p, p.bob, 25_000, 60_000)
  await fund(p, p.carol, 8_000, 30_000)
}

async function bootstrapBusiness(p: Parties) {
  const acmeUsd = await holdingsOf(p.acme, p.usdIssuer, 'USDx')
  if (acmeUsd.length) return
  log('seeding Acme, Nova and payroll preferences')
  await fund(p, p.acme, 80_000, 150_000)
  await fund(p, p.nova, 2_000, 0)
  // Bob takes his salary in CCx, the others in USDx.
  for (const [who, sym] of [
    [p.alice, 'USDx'],
    [p.bob, 'CCx'],
    [p.carol, 'USDx'],
  ] as const) {
    await ledger.submit([who], [setPreference(who, p.acme, sym)])
  }
  const due = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  await ledger.submit([p.nova], [
    issueInvoice(p.nova, p.acme, {
      invoiceNo: 'NOVA-1041',
      memo: 'Warehouse racking, phase 2',
      amount: 12_000,
      issuer: p.usdIssuer,
      symbol: 'USDx',
      dueDate: due(21),
    }),
  ])
  await ledger.submit([p.nova], [
    issueInvoice(p.nova, p.acme, {
      invoiceNo: 'NOVA-1042',
      memo: 'Forklift maintenance, November',
      amount: 1_850,
      issuer: p.usdIssuer,
      symbol: 'USDx',
      dueDate: due(9),
    }),
  ])
}

async function findMarket(p: Parties): Promise<Contract<LendingMarket> | undefined> {
  const markets = await ledger.query<LendingMarket>(p.operator, [L.LendingMarket])
  return markets.find((m) => m.payload.marketId === MARKET_ID)
}

async function bootstrapLending(p: Parties) {
  if (await findMarket(p)) return
  log('creating lending market', MARKET_ID)
  await ledger.submit([p.operator], [
    {
      CreateCommand: {
        templateId: L.LendingMarket,
        createArguments: {
          operator: p.operator,
          marketId: MARKET_ID,
          assetIssuer: p.usdIssuer,
          assetSymbol: 'USDx',
          collIssuer: p.ccIssuer,
          collSymbol: 'CCx',
          poolId: POOL_ID,
          cash: dec(0),
          cashHoldings: [],
          principalOut: dec(0),
          totalShares: dec(0),
          baseAprBps: dec(200),
          slopeAprBps: dec(1800),
          maxLtvBps: dec(6000),
          liqLtvBps: dec(8000),
          // Demo clock: one year of interest accrues every hour.
          yearSeconds: String(DEMO_YEAR_SECONDS), // Daml Int travels as a string
          badDebt: dec(0),
          members: members(p),
        },
      },
    },
  ])
  // Alice supplies 120,000 USDx.
  await fund(p, p.alice, 120_000, 0)
  const usd = await holdingsOf(p.alice, p.usdIssuer, 'USDx')
  await ledger.submit([p.alice], [supply(p.alice, p.operator, MARKET_ID, usd.map((t) => t.contractId), 120_000)])
  await settleOnce(p)

  // Acme borrows 15,000 USDx against 150,000 CCx of extra collateral.
  await fund(p, p.acme, 0, 150_000)
  const cc = await holdingsOf(p.acme, p.ccIssuer, 'CCx')
  const big = cc.find((t) => +t.payload.amount === 150_000) ?? cc[0]
  await ledger.submit([p.acme], [
    borrow({ borrower: p.acme, operator: p.operator, marketId: MARKET_ID, holdings: [big.contractId], collateralAmount: 150_000, borrowAmount: 15_000 }),
  ])
  await settleOnce(p)

  // Acme stands behind earned-wage advances of up to half a month's pay.
  for (const [who, limit] of [
    [p.alice, 1_500],
    [p.bob, 1_250],
    [p.carol, 2_100],
  ] as const) {
    await ledger.submit([p.acme], [
      {
        CreateCommand: {
          templateId: L.AdvanceLine,
          createArguments: { employer: p.acme, employee: who, operator: p.operator, marketId: MARKET_ID, limit: dec(limit), feeBps: dec(100), drawn: dec(0) },
        },
      },
    ])
  }
}

let exchange: ExchangeCtx | undefined
const exchangeParties = (p: Parties) => ({ operator: p.operator, usdIssuer: p.usdIssuer, traders: [p.alice, p.bob, p.carol, p.acme, p.nova] })

async function bootstrap(): Promise<Parties> {
  await uploadDars()
  const p = await ensureParties()
  if (NETWORK.appUser) {
    // Authenticated participant: one ledger user acts for all demo parties.
    await admin.ensureUser(NETWORK.appUser, Object.values(p))
    ledger = admin.as(NETWORK.appUser)
    log(`acting as ledger user "${NETWORK.appUser}"`)
  }
  await bootstrapMarket(p)
  await bootstrapBusiness(p)
  await bootstrapLending(p)
  if (NETWORK_NAME === 'localnet') {
    // Real Canton Coin is only available on a Splice network.
    exchange = await exchangeContext(() => ledger, log, exchangeParties(p))
    await bootstrapExchange(exchange, exchangeParties(p))
    await bootstrapPayroll(exchange, {
      operator: p.operator,
      usdIssuer: p.usdIssuer,
      employer: p.acme,
      employees: [
        { party: p.alice, wantsCC: false },
        { party: p.bob, wantsCC: true },
        { party: p.carol, wantsCC: false },
      ],
    })
  }
  log('demo world ready')
  return p
}

// ---------- settlement ----------

// What to do when executing a request fails.
const ON_FAIL: Record<string, (reason: string) => [string, unknown] | undefined> = {
  SwapRequest: (reason) => ['SwapRequest_Reject', { reason }],
  PayoutRequest: (reason) => ['PayoutRequest_Fallback', { reason }],
  InvoiceSettlement: (reason) => ['InvoiceSettlement_Reject', { reason }],
  BorrowRequest: (reason) => ['BorrowRequest_Reject', { reason }],
  AdvanceRequest: (reason) => ['AdvanceRequest_Reject', { reason }],
}

// Which contracts each request's Execute choice needs.
const NEEDS_MARKET = new Set(['SupplyRequest', 'WithdrawSupplyRequest', 'AdvanceRequest'])
const NEEDS_BOTH = new Set(['BorrowRequest'])

const failed = new Set<string>()

async function settleOnce(p: Parties) {
  const requests = await ledger.query<unknown>(p.operator, [
    T.SwapRequest,
    T.AddLiquidityRequest,
    T.RemoveLiquidityRequest,
    P.PayoutRequest,
    P.InvoiceSettlement,
    L.SupplyRequest,
    L.WithdrawSupplyRequest,
    L.BorrowRequest,
    L.AdvanceRequest,
  ])
  for (const req of requests) {
    if (failed.has(req.contractId)) continue
    const pool = await findPool(p)
    if (!pool) return
    const kind = req.templateId.split(':').pop()!
    const templateId = TEMPLATES[kind]
    try {
      let args: Record<string, string> = { poolCid: pool.contractId }
      if (NEEDS_MARKET.has(kind) || NEEDS_BOTH.has(kind)) {
        const market = await findMarket(p)
        if (!market) continue
        args = NEEDS_BOTH.has(kind) ? { marketCid: market.contractId, poolCid: pool.contractId } : { marketCid: market.contractId }
      }
      const tx = await ledger.submit([p.operator], [exercise(templateId, req.contractId, `${kind}_Execute`, args)])
      const receipt = createdOf(tx, T.SwapReceipt)
      if (receipt) {
        const r = receipt.createArgument as { symbolIn: string; amountIn: string; symbolOut: string; amountOut: string }
        log(`settled swap ${(+r.amountIn).toFixed(2)} ${r.symbolIn} -> ${(+r.amountOut).toFixed(4)} ${r.symbolOut}`)
      } else {
        log(`settled ${kind}`)
      }
    } catch (err) {
      const reason = err instanceof LedgerError ? err.message : String(err)
      log(`could not settle ${kind}: ${reason}`)
      const fallback = ON_FAIL[kind]?.(reason.slice(0, 200))
      try {
        if (fallback) {
          await ledger.submit([p.operator], [exercise(templateId, req.contractId, fallback[0], fallback[1])])
          log(`  -> ${fallback[0]}`)
        } else {
          // Liquidity requests have no operator-side reject: leave them for the
          // provider to cancel, but don't retry forever.
          failed.add(req.contractId)
        }
      } catch (e) {
        failed.add(req.contractId)
        log('  fallback failed', e instanceof Error ? e.message : e)
      }
    }
  }
}

// Liquidation keeper: close any loan whose debt crossed the threshold by
// selling its collateral through the pool.
async function liquidateOnce(p: Parties) {
  const loans = await ledger.query<Loan>(p.operator, [L.Loan])
  if (!loans.length) return
  const [market, pool] = await Promise.all([findMarket(p), findPool(p)])
  if (!market || !pool) return
  const m = marketView(market.payload)
  const price = +pool.payload.reserveA / +pool.payload.reserveB
  for (const loan of loans) {
    const l = loan.payload
    const owed = owedAt(m.yearSeconds, +l.principal, +l.aprBps, l.openedAt)
    const hf = healthFactor(+l.collateralAmount * price, m.liqLtv, owed)
    if (hf >= 1) continue
    try {
      const freshMarket = await findMarket(p)
      const freshPool = await findPool(p)
      await ledger.submit([p.operator], [
        exercise(L.Loan, loan.contractId, 'Loan_Liquidate', { marketCid: freshMarket!.contractId, poolCid: freshPool!.contractId }),
      ])
      log(`liquidated a loan (health ${hf.toFixed(3)}) through ${POOL_ID}`)
    } catch (err) {
      log('liquidation failed', err instanceof LedgerError ? err.message : err)
    }
  }
}

async function settleLoop(p: Parties) {
  for (;;) {
    try {
      await settleOnce(p)
      await liquidateOnce(p)
      if (exchange) {
        await convertPayOnce(exchange, p.operator)
        await settleExchangeOnce(exchange, p.operator)
      }
    } catch (err) {
      log('settle error', err instanceof Error ? err.message : err)
    }
    await new Promise((r) => setTimeout(r, TICK_MS))
  }
}

// ---------- http ----------

function serve(p: Parties) {
  const lastDrip = new Map<string, number>()
  const faucetable = [p.alice, p.bob, p.carol, p.acme, p.nova]
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method === 'GET' && req.url === '/api/config') {
        return send(200, {
          poolId: POOL_ID,
          marketId: MARKET_ID,
          network: NETWORK_NAME,
          exchange: exchange ? { poolId: EXCHANGE_POOL_ID, usdx: exchange.usdx, amulet: exchange.amulet } : undefined,
          operator: p.operator,
          issuers: { USDx: p.usdIssuer, CCx: p.ccIssuer },
          business: { employer: p.acme, supplier: p.nova, auditor: p.auditor, employees: [p.alice, p.bob, p.carol] },
          personas: [
            { key: 'alice', name: 'Alice', role: 'Liquidity provider · Acme engineer', party: p.alice, group: 'market' },
            { key: 'bob', name: 'Bob', role: 'Trader · Acme designer', party: p.bob, group: 'market' },
            { key: 'carol', name: 'Carol', role: 'Pool member · Acme analyst', party: p.carol, group: 'market' },
            { key: 'acme', name: 'Acme', role: 'Employer and buyer', party: p.acme, group: 'business' },
            { key: 'nova', name: 'Nova', role: 'Supplier', party: p.nova, group: 'business' },
            { key: 'auditor', name: 'Auditor', role: 'Sees totals only', party: p.auditor, group: 'business' },
          ],
        })
      }
      if (req.method === 'POST' && req.url === '/api/faucet') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const { party } = JSON.parse(raw || '{}') as { party?: string }
        if (!party || !faucetable.includes(party)) return send(400, { error: 'unknown party' })
        const now = Date.now()
        if (now - (lastDrip.get(party) ?? 0) < 5_000) return send(429, { error: 'slow down' })
        lastDrip.set(party, now)
        await fund(p, party, 1_000, 5_000)
        if (exchange) await fundTrader(exchange, exchangeParties(p), party)
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
      await admin.ledgerEnd()
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
