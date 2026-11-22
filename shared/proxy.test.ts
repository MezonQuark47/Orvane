import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factoryExerciseOf, loadProxy, proxiedDisclosed, wrapTransfer, PROXY_TEMPLATE, type ProxyInfo } from './proxy.ts'

const proxy: ProxyInfo = {
  provider: 'orvane-app::1220aa',
  contract: { templateId: 'pkg:Splice.Util.FeaturedApp.WalletUserProxy:WalletUserProxy', contractId: '00proxy', createdEventBlob: 'blob', synchronizerId: 'global::1220' },
}

// The shape a wallet or registry prepares for a V1 transfer (as Loop's
// prepareTransfer and Scan's transfer-factory endpoint return it).
const transferCommand = {
  ExerciseCommand: {
    templateId: '55ba4deb:Splice.Api.Token.TransferInstructionV1:TransferFactory',
    contractId: '00factory',
    choice: 'TransferFactory_Transfer',
    choiceArgument: {
      expectedAdmin: 'DSO::1220',
      transfer: {
        sender: 'alice::1220',
        receiver: 'cantex-swap::1220',
        amount: '55.0',
        instrumentId: { admin: 'DSO::1220', id: 'Amulet' },
        requestedAt: '2026-11-23T00:00:00Z',
        executeBefore: '2026-11-23T01:00:00Z',
        inputHoldingCids: ['00h1'],
        meta: { values: { 'splice.lfdecentralizedtrust.org/reason': 'USDCx' } },
      },
      extraArgs: { context: { values: {} }, meta: { values: {} } },
    },
  },
}

test('wraps the exact transfer in the proxy, with no featured app right', () => {
  const call = factoryExerciseOf([transferCommand])
  const cmd = wrapTransfer(proxy, call)
  assert.ok('ExerciseCommand' in cmd)
  const ex = cmd.ExerciseCommand
  assert.equal(ex.templateId, PROXY_TEMPLATE)
  assert.equal(ex.contractId, '00proxy')
  assert.equal(ex.choice, 'WalletUserProxy_BatchTransfer')
  const arg = ex.choiceArgument as { transferCalls: unknown[]; optFeaturedAppRightCid: unknown }
  assert.equal(arg.optFeaturedAppRightCid, null)
  assert.deepEqual(arg.transferCalls, [{ factoryCid: '00factory', choiceArg: transferCommand.ExerciseCommand.choiceArgument }])
})

test('refuses anything but one V1 transfer', () => {
  assert.throws(() => factoryExerciseOf([]), /one transfer command/)
  assert.throws(() => factoryExerciseOf([transferCommand, transferCommand]), /one transfer command/)
  const other = { ExerciseCommand: { ...transferCommand.ExerciseCommand, choice: 'TransferFactory_PublicFetch' } }
  assert.throws(() => factoryExerciseOf([other]), /not a token-standard transfer/)
  const v2 = { ExerciseCommand: { ...transferCommand.ExerciseCommand, templateId: 'x:Splice.Api.Token.TransferInstructionV2:TransferFactory' } }
  assert.throws(() => factoryExerciseOf([v2]), /V1/)
  assert.throws(() => factoryExerciseOf([{ CreateCommand: {} }]), /not a token-standard transfer/)
})

test('adds the proxy to the disclosed contracts once', () => {
  const amulet = { templateId: 't', contractId: '00rules', createdEventBlob: 'b', synchronizerId: 's' }
  assert.deepEqual(
    proxiedDisclosed(proxy, [amulet]).map((d) => d.contractId),
    ['00rules', '00proxy'],
  )
  assert.deepEqual(
    proxiedDisclosed(proxy, [amulet, proxy.contract]).map((d) => d.contractId),
    ['00rules', '00proxy'],
  )
})

test('loads proxy settings only when they are complete', async () => {
  const respond = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
  assert.equal(await loadProxy(undefined, respond(proxy)), undefined)
  assert.deepEqual(await loadProxy('/p.json', respond(proxy)), proxy)
  assert.equal(await loadProxy('/p.json', respond(proxy, false)), undefined)
  assert.equal(await loadProxy('/p.json', respond({ provider: 'x' })), undefined)
})
