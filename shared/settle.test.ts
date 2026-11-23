import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dec, type Dec } from './decimal.ts'
import type { Instrument } from './cantex.ts'
import { arrived, moved, sent, settle, type SettledSwap } from './settle.ts'

const CC = { admin: 'DSO::1220', id: 'Amulet' }
const USDCX = { admin: 'usdc::1220', id: 'USDCx' }
const WATCH = 20 * 60_000
const T0 = 1_700_000_000_000

const swap = (over: Partial<SettledSwap> = {}): SettledSwap => ({
  id: 'a',
  at: T0,
  status: 'pending',
  sell: { ...CC, amount: '100.0' },
  quoted: { ...USDCX, amount: '7.0' },
  sellBefore: '500.0',
  buyBefore: '10.0',
  ...over,
})

const wallet = (cc: string, usdcx: string) => (i: Instrument): Dec => dec(i.id === 'Amulet' ? cc : usdcx)

test('a pending swap fills when the buy token arrives', () => {
  const [r] = settle([swap()], wallet('400.0', '16.9'), T0 + 5 * 60_000, WATCH)
  assert.equal(r.status, 'filled')
  assert.equal(r.received, '6.9000000000')
})

test('an unconfirmed swap counts as sent once the sell token is gone, then fills', () => {
  const [mid] = settle([swap({ status: 'unconfirmed' })], wallet('400.0', '10.0'), T0 + 60_000, WATCH)
  assert.equal(mid.status, 'pending')
  const [end] = settle([mid], wallet('400.0', '17.0'), T0 + 90_000, WATCH)
  assert.equal(end.status, 'filled')
  assert.equal(end.received, '7.0000000000')
})

test('an unconfirmed swap does not fill from a buy token that arrived without the sell token leaving', () => {
  const [r] = settle([swap({ status: 'unconfirmed' })], wallet('500.0', '17.0'), T0 + 60_000, WATCH)
  assert.equal(r.status, 'unconfirmed')
})

test('past the window a swap is no longer settled from the balances', () => {
  const late = T0 + WATCH + 1
  assert.equal(settle([swap({ status: 'unconfirmed' })], wallet('300.0', '10.0'), late, WATCH)[0].status, 'unconfirmed')
  assert.equal(settle([swap()], wallet('400.0', '30.0'), late, WATCH)[0].status, 'pending')
})

test('a swap left signing by a closed page is treated as unconfirmed', () => {
  const [r] = settle([swap({ status: 'sending' })], wallet('500.0', '10.0'), T0 + 60_000, WATCH)
  assert.equal(r.status, 'unconfirmed')
})

test("another swap's sale is not read as the unconfirmed swap leaving the wallet", () => {
  // the wallet never answered for the first swap; the user swapped again and that one went out
  const first = swap({ id: 'first', status: 'unconfirmed' })
  const second = swap({ id: 'second', at: T0 + 60_000, status: 'pending' })
  const rows = moved([first, second], 'second', CC, -dec('100.0'))
  const [r] = settle(rows, wallet('400.0', '10.0'), T0 + 90_000, WATCH)
  assert.equal(r.status, 'unconfirmed')
  // if the first one is signed after all, it still shows
  assert.equal(settle(rows, wallet('300.0', '10.0'), T0 + 120_000, WATCH)[0].status, 'pending')
})

test("another swap's output is not read as the pending swap's fill", () => {
  const rows = moved([swap({ id: 'old' }), swap({ id: 'new', at: T0 + 60_000, status: 'filled' })], 'new', USDCX, dec('7.0'))
  assert.equal(settle(rows, wallet('300.0', '17.0'), T0 + 90_000, WATCH)[0].status, 'pending')
  assert.equal(settle(rows, wallet('300.0', '24.0'), T0 + 90_000, WATCH)[0].received, '7.0000000000')
})

test('two open swaps into the same token each get their own output, oldest first', () => {
  const older = swap({ id: 'old', at: T0 })
  const newer = swap({ id: 'new', at: T0 + 30_000 })
  const once = settle([newer, older], wallet('300.0', '17.0'), T0 + 60_000, WATCH)
  assert.deepEqual(
    once.map((r) => [r.id, r.status, r.received]),
    [
      ['new', 'pending', undefined],
      ['old', 'filled', '7.0000000000'],
    ],
  )
  const twice = settle(once, wallet('300.0', '23.5'), T0 + 90_000, WATCH)
  assert.equal(twice.find((r) => r.id === 'new')?.received, '6.5000000000')
})

test('while a swap is in progress, open swaps on the same tokens wait for it', () => {
  const rows = [swap({ id: 'open' }), swap({ id: 'live', at: T0 + 60_000, status: 'sending' })]
  const next = settle(rows, wallet('300.0', '17.0'), T0 + 90_000, WATCH, (id) => id === 'live')
  assert.deepEqual(next, rows)
})

test('settled swaps and ones without baselines are left alone', () => {
  const rows = [swap({ id: 'done', status: 'filled', received: '7.0' }), swap({ id: 'old', sellBefore: undefined, buyBefore: undefined })]
  assert.deepEqual(settle(rows, wallet('400.0', '30.0'), T0 + 60_000, WATCH), rows)
})

test('moved leaves the mover and settled swaps alone', () => {
  const rows = [swap({ id: 'mover' }), swap({ id: 'done', status: 'filled' }), swap({ id: 'open', status: 'unconfirmed' })]
  const next = moved(rows, 'mover', CC, -dec('40.0'))
  assert.deepEqual(
    next.map((r) => r.sellBefore),
    ['500.0', '500.0', '460.0000000000'],
  )
})

test('sent allows a little slack, arrived needs more than before', () => {
  assert.equal(sent(swap(), dec('400.9')), true)
  assert.equal(sent(swap(), dec('401.1')), false)
  assert.equal(arrived(swap(), dec('10.0')), undefined)
  assert.equal(arrived(swap(), dec('10.5')), dec('0.5'))
})
