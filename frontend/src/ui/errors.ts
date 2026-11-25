// Turns ledger and network failures into something a person can act on.
//
// Canton errors arrive as JSON with a cause like "Interpretation error: ...
// check failed: <reason>". The DEX contracts state each check as what must
// hold; those map to a sentence plus a hint. Wallet errors (CIP-0103) and
// network failures are covered too. Anything unknown falls through as-is.

import { LedgerError } from '../../../shared/ledger.ts'
import { NETWORK } from '../ledger/network.ts'

export interface Explained {
  title: string
  hint?: string
  /** The original message, for the details view. */
  raw: string
}

type Rule = [RegExp, string, string?]

const RULES: Rule[] = [
  // the wallet
  [/popup/i, "Your browser blocked the wallet window", "Allow pop-ups for this site, then connect again."],
  [/user rejected|rejected by user|user denied|declined|4001/i, 'You declined in your wallet', 'Nothing was signed and nothing moved.'],
  [/not connected|no wallet|connect a wallet/i, 'Connect a wallet first'],
  [/gateway|3030|walletconnect|session expired|4100|unauthori[sz]ed/i, "Your wallet isn't reachable", 'Check that the wallet is running and you are signed in, then connect again.'],

  // reaching the network
  [
    /failed to fetch|networkerror|load failed|econnrefused|bad gateway|service unavailable/i,
    "Can't reach the network",
    NETWORK.pool ? 'Check that LocalNet and the Orvane operator are running, then try again.' : 'Check your connection and try again in a moment. Nothing was sent.',
  ],
  [/deadline_exceeded|timed? ?out|timeout/i, 'The network took too long to answer', 'It may still settle. Check Activity in a moment before retrying.'],
  [/duplicate_command/i, 'Already submitted', 'The same request is still being processed.'],
  [/contract_not_found|could not be found|inactive_contracts|locked_contracts|contract.*(archived|consumed)/i, 'Something changed while you were signing', 'Another transaction used these funds first. Try again.'],

  // what the operator hands back (the contract's own checks)
  [/not settled yet/i, "It hasn't settled yet", 'The operator may be busy. If it is handed back, your funds unlock by themselves.'],
  [/output meets the trader's minimum/i, 'The price moved past your limit', 'Nothing was spent. Allow a little more slippage or trade a smaller amount.'],
  [/swap deadline/i, 'The swap waited too long', 'Nothing was spent. Try again.'],
  [/close enough to the pool price/i, 'The pool price moved', 'Your deposit was handed back. Try again at the new price.'],
  [/room for another position|pool is full/i, 'The pool is full', 'It takes a limited number of providers. Try again later.'],
  [/pool status|paused/i, 'The pool is paused', 'Swaps and new deposits are on hold. You can still withdraw.'],
  [/shorter than the pool's minimum|longer than the pool's maximum|term end/i, "That term isn't allowed", 'Pick one of the offered terms.'],
  [/pays out something|keeps some of the output/i, 'That amount is too small or too large for the pool'],
  [/no open position/i, 'That position is already closed'],

  // balances
  [/not enough funds|insufficient (balance|funds)|missing amount/i, 'Not enough balance', 'Lower the amount, or wait for your funds to unlock.'],
  [/at least one input holding/i, 'Not enough balance', 'You have no free holdings of this asset.'],
]

const sentence = (s: string) => {
  const t = s.trim().replace(/^error:\s*/i, '')
  if (!t) return 'Something went wrong'
  return t[0].toUpperCase() + t.slice(1)
}

export function explain(e: unknown): Explained {
  const raw =
    e instanceof LedgerError ? e.message : e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e)
  // match on the full body too: the error code sits outside the summary
  const haystack = e instanceof LedgerError ? `${raw} ${e.body} ${e.status === 502 || e.status === 503 ? 'bad gateway' : ''}` : raw
  for (const [re, title, hint] of RULES) if (re.test(haystack)) return { title, hint, raw }
  return { title: sentence(raw), raw }
}

/** One line for inline error spots. */
export function errorText(e: unknown) {
  const x = explain(e)
  return x.hint ? `${x.title}. ${x.hint}` : x.title
}
