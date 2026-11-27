// /api/oneswap on Vercel: see shared/oneswap-forward.ts. Active where
// ONESWAP_API_KEY is set (the DevNet site).

import { forwardOneSwap } from '../shared/oneswap-forward.ts'

const forward = (request: Request) => forwardOneSwap(request, process.env.ONESWAP_API_KEY)

export const GET = forward
export const POST = forward
