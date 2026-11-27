// /api/oneswap on Cloudflare Pages: see shared/oneswap-forward.ts. Active where
// the ONESWAP_API_KEY secret is set (the DevNet site). Cloudflare picks this
// file up from the functions/ folder at the project root.

import { forwardOneSwap } from '../../shared/oneswap-forward.ts'

type Context = { request: Request; env: { ONESWAP_API_KEY?: string } }

const forward = ({ request, env }: Context) => forwardOneSwap(request, env.ONESWAP_API_KEY)

export const onRequestGet = forward
export const onRequestPost = forward
