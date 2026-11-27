// The server side of the app's OneSwap calls (DevNet only): forwards them to
// OneSwap's API with Orvane's integrator key, which must never reach the
// browser. Only the calls the app makes are passed on. Shared by the hosting
// adapters, api/oneswap.ts (Vercel) and functions/api/oneswap.ts (Cloudflare
// Pages).
//
//   /api/oneswap?path=/api/rt/pools

const ONESWAP = 'https://devnet.api.oneswap.cc/swapv2'

const ALLOWED = [
  /^GET \/api\/rt\/(tokens|pools)$/,
  /^POST \/api\/rt\/pool\/[\w-]+\/quote$/,
  /^POST \/api\/sdk\/escrow\/swap$/,
  /^GET \/api\/sdk\/escrow\/swap\/[\w-]+$/,
  /^GET \/api\/sdk\/escrow\/open-swap$/,
  /^POST \/api\/sdk\/escrow\/swap\/[\w-]+\/cancel$/,
]

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers one /api/oneswap request; `key` is the integrator key, absent where OneSwap is not set up. */
export async function forwardOneSwap(request: Request, key: string | undefined): Promise<Response> {
  if (!key) return json(503, { error: 'OneSwap is not set up on this site' })
  const url = new URL(request.url)
  const path = url.searchParams.get('path') ?? ''
  if (!ALLOWED.some((re) => re.test(`${request.method} ${path}`))) return json(404, { error: 'not a OneSwap call this app makes' })
  url.searchParams.delete('path')
  const query = url.searchParams.toString()
  // a server-side call with fresh headers: the browser's Origin is not passed on
  const res = await fetch(`${ONESWAP}${path}${query ? `?${query}` : ''}`, {
    method: request.method,
    headers: { 'x-sdk-key': key, 'content-type': 'application/json' },
    body: request.method === 'POST' ? await request.text() : undefined,
  })
  return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
}
