// End-to-end check of the DEX on a running LocalNet with the operator up.
//
// Providers and a trader live on the app-user participant, the operator on
// the app-provider participant, as wallet users and the operator will in
// practice, so nothing works unless the registries disclose what each side
// needs. Runs: funding (offers + accept), two deposits, swaps both ways,
// a withdrawal, a renewal, and checks the books and privacy after each.
//
//   node scripts/e2e-localnet.ts

import { JsonLedger } from '../shared/ledger.ts'
import { dec, show, sum, type Dec } from '../shared/decimal.ts'
import {
  DEX,
  HOLDING_V2,
  TRANSFER_INSTRUCTION_V2,
  allocateArgs,
  basicAccount,
  minOutFor,
  placeDeposit,
  placeSwap,
  poolSettlement,
  quote,
  requestRenew,
  requestWithdraw,
  type InstrumentId,
  type LpPosition,
  type PoolState,
  type SwapReceipt,
} from '../shared/dex.ts'
import { dedupeDisclosed } from '../shared/registry.ts'
import { authFor, connect } from '../operator/network.ts'
import { offerTestToken, sendCanton } from '../operator/fund.ts'

const USER_PARTICIPANT = 'http://localhost:2975'
const POOL = 'CC-TestUSD'

const net = await connect({ setup: false })
const say = (...a: unknown[]) => console.log('  ', ...a)
let failures = 0
function check(what: string, ok: boolean, detail = '') {
  console.log(ok ? '  ok  ' : '  FAIL', what, ok ? '' : detail)
  if (!ok) failures++
}

// ---------- parties on the user participant ----------

const userAdmin = new JsonLedger(USER_PARTICIPANT, net.cfg.ledger.adminUser, authFor(net.cfg))
const run = Date.now().toString(36)
const known = await userAdmin.listParties()
const party = async (hint: string) => known.find((p) => p.startsWith(`${hint}::`)) ?? userAdmin.allocateParty(hint)
const lp1 = await party(`e2e-lp1-${run}`)
const lp2 = await party(`e2e-lp2-${run}`)
const trader = await party(`e2e-trader-${run}`)
await userAdmin.ensureUser('orvane-e2e', [lp1, lp2, trader])
const wallet = userAdmin.as('orvane-e2e')

const cc = net.instruments.CC
const usd = net.instruments.TestUSD
const operator = net.operator
const settlement = poolSettlement(operator, POOL)

interface Holding {
  account: { owner: string | null }
  instrumentId: InstrumentId
  amount: string
  lock: unknown
}

async function holdings(p: string, i: InstrumentId) {
  const rows = await wallet.queryInterface<Holding>(p, HOLDING_V2)
  return rows.filter((h) => h.view.account.owner === p && h.view.instrumentId.admin === i.admin && h.view.instrumentId.id === i.id)
}
const free = async (p: string, i: InstrumentId) => sum((await holdings(p, i)).filter((h) => !h.view.lock).map((h) => dec(h.view.amount)))
const locked = async (p: string, i: InstrumentId) => sum((await holdings(p, i)).filter((h) => h.view.lock).map((h) => dec(h.view.amount)))
const freeIds = async (p: string, i: InstrumentId) => (await holdings(p, i)).filter((h) => !h.view.lock).map((h) => h.contractId)

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await probe()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 1_000))
  }
}

// ---------- funding: offers from the network, accepted by the receiver ----------

async function acceptIncoming(p: string) {
  const offers = await wallet.queryInterface<{ transfer: { receiver: { owner: string }; instrumentId: InstrumentId } }>(p, TRANSFER_INSTRUCTION_V2)
  for (const o of offers.filter((x) => x.view.transfer.receiver.owner === p)) {
    const ctx = await net.registries.for(o.view.transfer.instrumentId.admin).transferChoice(o.contractId, 'accept')
    await wallet.submit(
      [p],
      [{ ExerciseCommand: { templateId: TRANSFER_INSTRUCTION_V2, contractId: o.contractId, choice: 'TransferInstruction_Accept', choiceArgument: { actors: [p], extraArgs: ctx.extraArgs } } }],
      [],
      dedupeDisclosed(ctx.disclosed),
    )
  }
  return offers.length
}

console.log('funding')
for (const [p, ccAmount, usdAmount] of [
  [lp1, 20_000, 100],
  [lp2, 8_000, 40],
  [trader, 3_000, 20],
] as const) {
  await offerTestToken(net, usd, p, usdAmount)
  await sendCanton(net, cc, p, ccAmount)
  const n = await until('offers to arrive', async () => {
    const offers = await wallet.queryInterface(p, TRANSFER_INSTRUCTION_V2)
    return offers.length >= 2 ? offers.length : undefined
  })
  await acceptIncoming(p)
  check(`${p.split('::')[0]} accepted ${n} offers`, (await free(p, cc)) >= dec(ccAmount) && (await free(p, usd)) === dec(usdAmount))
}

// ---------- books ----------

async function books() {
  const state = (await net.ledger.query<PoolState>(operator, [DEX.PoolState])).find((s) => s.payload.poolId === POOL)!.payload
  const positions = (await net.ledger.query<LpPosition>(operator, [DEX.LpPosition])).filter((p) => p.payload.poolId === POOL)
  return { state, positions }
}

async function checkBooks(label: string) {
  const { state, positions } = await books()
  const a = sum(positions.map((p) => dec(p.payload.amountA)))
  const b = sum(positions.map((p) => dec(p.payload.amountB)))
  check(`${label}: reserves equal the positions`, dec(state.reserveA) === a && dec(state.reserveB) === b, `${state.reserveA}/${state.reserveB} vs ${show(a)}/${show(b)}`)
  for (const p of positions.filter((x) => [lp1, lp2].includes(x.payload.provider))) {
    const [la, lb] = await Promise.all([locked(p.payload.provider, cc), locked(p.payload.provider, usd)])
    check(`${label}: ${p.payload.provider.split('::')[0]} has exactly its position locked`, la === dec(p.payload.amountA) && lb === dec(p.payload.amountB), `${show(la)}/${show(lb)} vs ${p.payload.amountA}/${p.payload.amountB}`)
  }
}

// ---------- liquidity ----------

async function factoryFor(i: InstrumentId, owner: string, args: Parameters<typeof allocateArgs>[0]) {
  return net.registries.for(i.admin).allocationFactory(allocateArgs({ ...args, owner }))
}

async function deposit(lp: string, amountA: Dec, amountB: Dec, termMinutes: number) {
  const requestId = `e2e-${run}-${lp.split('::')[0]}`
  const now = new Date()
  const requestedAt = new Date(now.getTime() - 5_000)
  const termEnd = new Date(now.getTime() + termMinutes * 60_000)
  const [holdA, holdB] = await Promise.all([freeIds(lp, cc), freeIds(lp, usd)])
  const base = { settlement, sides: [], deadline: termEnd, committed: true, requestedAt }
  const [fa, fb] = await Promise.all([
    factoryFor(cc, lp, { ...base, admin: cc.admin, owner: lp, funding: { [cc.id]: show(amountA) }, inputHoldingCids: holdA }),
    factoryFor(usd, lp, { ...base, admin: usd.admin, owner: lp, funding: { [usd.id]: show(amountB) }, inputHoldingCids: holdB }),
  ])
  await wallet.submit(
    [lp],
    [placeDeposit({ provider: lp, operator, poolId: POOL, requestId, instrumentA: cc, amountA, instrumentB: usd, amountB, termEnd, factoryA: fa, holdingsA: holdA, factoryB: fb, holdingsB: holdB, requestedAt })] as never,
    [],
    dedupeDisclosed([...fa.disclosed, ...fb.disclosed]),
  )
  return until('the position to open', async () => (await books()).positions.find((p) => p.payload.positionId === requestId))
}

// The other side of a deposit at the pool's current price (or 0.005 USD per
// CC if the pool is empty).
async function atPoolPrice(amountA: Dec): Promise<Dec> {
  const { state } = await books()
  if (state.positions === '0') return (amountA * 5n) / 1000n
  return (amountA * dec(state.reserveB)) / dec(state.reserveA)
}

console.log('liquidity')
await deposit(lp1, dec(16_000), await atPoolPrice(dec(16_000)), 60)
await checkBooks('after the first deposit')
await deposit(lp2, dec(6_000), await atPoolPrice(dec(6_000)), 60)
await checkBooks('after the second deposit')

// ---------- swaps ----------

async function swap(sellCc: boolean, amountIn: Dec) {
  const { state } = await books()
  const [inI, outI] = sellCc ? [cc, usd] : [usd, cc]
  const [rIn, rOut] = sellCc ? [dec(state.reserveA), dec(state.reserveB)] : [dec(state.reserveB), dec(state.reserveA)]
  const q = quote({ feeBps: 30, reserveIn: rIn, reserveOut: rOut }, amountIn)
  const requestId = `e2e-${run}-swap-${Date.now().toString(36)}`
  const requestedAt = new Date(Date.now() - 5_000)
  const deadline = new Date(Date.now() + 10 * 60_000)
  const ids = await freeIds(trader, inI)
  const side = { transferLegId: `${requestId}/in`, side: 'SenderSide', otherside: basicAccount(operator), amount: show(amountIn), instrumentId: inI.id, meta: { values: {} } }
  const factory = await factoryFor(inI, trader, { settlement, admin: inI.admin, owner: trader, sides: [side], deadline, funding: null, committed: false, requestedAt, inputHoldingCids: ids })
  const before = { in: await free(trader, inI), out: await free(trader, outI) }
  await wallet.submit(
    [trader],
    [placeSwap({ trader, operator, poolId: POOL, requestId, instrumentIn: inI, amountIn, instrumentOut: outI, minOut: minOutFor(q.amountOut, 100), deadline, factory, inputHoldingCids: ids, requestedAt })] as never,
    [],
    dedupeDisclosed(factory.disclosed),
  )
  const receipt = await until('the swap to settle', async () => (await wallet.query<SwapReceipt>(trader, [DEX.SwapReceipt])).find((r) => r.payload.requestId === requestId))
  const got = dec(receipt.payload.amountOut)
  check(`swap ${show(amountIn)} ${inI.id}: filled at the quote`, got === q.amountOut, `${show(got)} vs quote ${show(q.amountOut)}`)
  const after = { in: await free(trader, inI), out: await free(trader, outI) }
  check(`swap ${show(amountIn)} ${inI.id}: trader paid exactly the input`, before.in - after.in === amountIn, show(before.in - after.in))
  check(`swap ${show(amountIn)} ${inI.id}: trader received exactly the output`, after.out - before.out === got, show(after.out - before.out))
  say(`${show(amountIn)} ${inI.id} -> ${show(got)} ${outI.id}`)
}

console.log('swaps')
await swap(true, dec(1_000))
await checkBooks('after selling CC')
await swap(false, dec(2))
await checkBooks('after selling TestUSD')

// ---------- privacy ----------

console.log('privacy')
const traderSees = await wallet.query(trader, [DEX.LpPosition, DEX.PoolState])
check('the trader sees no positions and no pool state', traderSees.length === 0)
const lp1Sees = await wallet.query<LpPosition>(lp1, [DEX.LpPosition])
check('a provider sees only its own position', lp1Sees.length === 1 && lp1Sees[0].payload.provider === lp1)
check('a provider sees no trades', (await wallet.query(lp1, [DEX.SwapReceipt])).length === 0)

// ---------- leaving and renewing ----------

console.log('withdraw and renew')
const lp2FreeBefore = { a: await free(lp2, cc), b: await free(lp2, usd) }
const lp2Pos = (await books()).positions.find((p) => p.payload.provider === lp2)!
await wallet.submit([lp2], [requestWithdraw(lp2, operator, POOL, lp2Pos.payload.positionId)] as never)
await until('the withdrawal', async () => ((await books()).positions.some((p) => p.payload.provider === lp2) ? undefined : true))
check('the provider got its whole position back', (await free(lp2, cc)) - lp2FreeBefore.a === dec(lp2Pos.payload.amountA) && (await free(lp2, usd)) - lp2FreeBefore.b === dec(lp2Pos.payload.amountB))
check('nothing stays locked for the provider', (await locked(lp2, cc)) === 0n && (await locked(lp2, usd)) === 0n)
await checkBooks('after the withdrawal')

const lp1Pos = (await books()).positions.find((p) => p.payload.provider === lp1)!
const newEnd = new Date(Date.now() + 2 * 3600_000)
await wallet.submit([lp1], [requestRenew(lp1, operator, POOL, lp1Pos.payload.positionId, newEnd)] as never)
const renewed = await until('the renewal', async () =>
  (await books()).positions.find((p) => p.payload.provider === lp1 && Date.parse(p.payload.termEnd) === newEnd.getTime()),
)
check('the renewed position keeps its amounts', renewed.payload.amountA === lp1Pos.payload.amountA && renewed.payload.amountB === lp1Pos.payload.amountB)
await checkBooks('after the renewal')
await swap(true, dec(250))
await checkBooks('after a swap on the renewed position')

// ---------- handing things back ----------

console.log('rejections')
async function rejectedFor(p: string, requestId: string) {
  return until(`the rejection of ${requestId}`, async () =>
    (await wallet.query<{ requestId: string; reason: string }>(p, [DEX.RequestRejected])).find((r) => r.payload.requestId === requestId),
  )
}

{
  // a trader asks for more than the pool can give
  const amountIn = dec(100)
  const requestId = `e2e-${run}-greedy`
  const requestedAt = new Date(Date.now() - 5_000)
  const deadline = new Date(Date.now() + 10 * 60_000)
  const ids = await freeIds(trader, cc)
  const side = { transferLegId: `${requestId}/in`, side: 'SenderSide', otherside: basicAccount(operator), amount: show(amountIn), instrumentId: cc.id, meta: { values: {} } }
  const factory = await factoryFor(cc, trader, { settlement, admin: cc.admin, owner: trader, sides: [side], deadline, funding: null, committed: false, requestedAt, inputHoldingCids: ids })
  const before = await free(trader, cc)
  await wallet.submit(
    [trader],
    [placeSwap({ trader, operator, poolId: POOL, requestId, instrumentIn: cc, amountIn, instrumentOut: usd, minOut: dec(1_000), deadline, factory, inputHoldingCids: ids, requestedAt })] as never,
    [],
    dedupeDisclosed(factory.disclosed),
  )
  const r = await rejectedFor(trader, requestId)
  say(`rejected: ${r.payload.reason.slice(0, 90)}`)
  check('an unfillable swap hands the input straight back', (await free(trader, cc)) === before && (await locked(trader, cc)) === 0n)
}

{
  // a provider deposits far from the pool price
  const before = { a: await free(lp2, cc), b: await free(lp2, usd) }
  const requestId = `e2e-${run}-${lp2.split('::')[0]}`
  const termEnd = new Date(Date.now() + 60 * 60_000)
  const requestedAt = new Date(Date.now() - 5_000)
  const [holdA, holdB] = await Promise.all([freeIds(lp2, cc), freeIds(lp2, usd)])
  const base = { settlement, sides: [], deadline: termEnd, committed: true, requestedAt }
  const [fa, fb] = await Promise.all([
    factoryFor(cc, lp2, { ...base, admin: cc.admin, owner: lp2, funding: { [cc.id]: '1000.0000000000' }, inputHoldingCids: holdA }),
    factoryFor(usd, lp2, { ...base, admin: usd.admin, owner: lp2, funding: { [usd.id]: '30.0000000000' }, inputHoldingCids: holdB }),
  ])
  await wallet.submit(
    [lp2],
    [placeDeposit({ provider: lp2, operator, poolId: POOL, requestId: `${requestId}-skewed`, instrumentA: cc, amountA: dec(1_000), instrumentB: usd, amountB: dec(30), termEnd, factoryA: fa, holdingsA: holdA, factoryB: fb, holdingsB: holdB, requestedAt })] as never,
    [],
    dedupeDisclosed([...fa.disclosed, ...fb.disclosed]),
  )
  const r = await rejectedFor(lp2, `${requestId}-skewed`)
  say(`rejected: ${r.payload.reason.slice(0, 90)}`)
  check('a skewed deposit releases its committed funds at once', (await free(lp2, cc)) === before.a && (await free(lp2, usd)) === before.b)
  await checkBooks('after the rejections')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
