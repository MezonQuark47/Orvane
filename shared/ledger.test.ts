import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { JsonLedger, bearer, oidcToken, type OidcAuth } from './ledger.ts'

// A stand-in identity provider and participant on a local port.
async function server(handle: (req: IncomingMessage, body: string) => { status?: number; json: unknown }) {
  const seen: Array<{ path: string; body: string; authorization?: string }> = []
  const s = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    seen.push({ path: req.url ?? '', body, authorization: req.headers.authorization })
    const r = handle(req, body)
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json))
  })
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
  return { url, seen, close: () => new Promise<void>((ok) => s.close(() => ok())) }
}

const auth = (url: string, clientId: string): OidcAuth => ({ tokenUrl: `${url}/oauth/token`, clientId, clientSecret: 's3cret', audience: 'https://canton.network.global' })

test('logs in with client credentials and reuses the token while it is valid', async () => {
  const idp = await server(() => ({ json: { access_token: 'tok-1', expires_in: 3600 } }))
  try {
    assert.equal(await oidcToken(auth(idp.url, 'reuse')), 'tok-1')
    assert.equal(await oidcToken(auth(idp.url, 'reuse')), 'tok-1')
    assert.equal(idp.seen.length, 1)
    const form = new URLSearchParams(idp.seen[0].body)
    assert.equal(form.get('grant_type'), 'client_credentials')
    assert.equal(form.get('client_id'), 'reuse')
    assert.equal(form.get('client_secret'), 's3cret')
    assert.equal(form.get('audience'), 'https://canton.network.global')
  } finally {
    await idp.close()
  }
})

test('logs in again when the token is about to expire', async () => {
  let n = 0
  const idp = await server(() => ({ json: { access_token: `tok-${++n}`, expires_in: 30 } }))
  try {
    assert.equal(await oidcToken(auth(idp.url, 'short')), 'tok-1')
    assert.equal(await oidcToken(auth(idp.url, 'short')), 'tok-2')
  } finally {
    await idp.close()
  }
})

test('a refused login says where and why', async () => {
  const idp = await server(() => ({ status: 401, json: { error: 'invalid_client' } }))
  try {
    await assert.rejects(oidcToken(auth(idp.url, 'refused')), /login at .*\/oauth\/token failed: 401 .*invalid_client/)
  } finally {
    await idp.close()
  }
})

test('the ledger client sends the OIDC token', async () => {
  const idp = await server(() => ({ json: { access_token: 'tok-ledger', expires_in: 3600 } }))
  const ledger = await server(() => ({ json: { offset: 7 } }))
  try {
    const client = new JsonLedger(ledger.url, 'orvane-app-user', auth(idp.url, 'ledger'))
    assert.equal(await client.ledgerEnd(), 7)
    assert.equal(ledger.seen[0].authorization, 'Bearer tok-ledger')
  } finally {
    await idp.close()
    await ledger.close()
  }
})

test('the development login names the ledger user in its token', async () => {
  const header = await bearer({ secret: 'unsafe', audience: 'aud' }, 'orvane')
  const payload = JSON.parse(Buffer.from(header.split(' ')[1].split('.')[1], 'base64url').toString()) as { sub: string; aud: string }
  assert.deepEqual([payload.sub, payload.aud], ['orvane', 'aud'])
})
