// Turns ledger and network failures into something a person can act on.
//
// Canton errors arrive as JSON with a cause like "Interpretation error: ...
// Assertion failed: insufficient balance" (LedgerError already pulls out the
// assertion). The Daml contracts fail with short lower-case reasons; those are
// mapped to a sentence plus a hint. Anything unknown falls through as-is.

import { LedgerError } from '../../../shared/ledger.ts'

export interface Explained {
  title: string
  hint?: string
  /** The original message, for the details view. */
  raw: string
}

type Rule = [RegExp, string, string?]

const RULES: Rule[] = [
  // reaching the ledger
  [/failed to fetch|networkerror|load failed|econnrefused|bad gateway|service unavailable/i, "Can't reach the ledger", 'Check that Canton and the Orvane operator are running, then try again.'],
  [/unauthenticated|permission_denied|invalid token|jwt/i, 'The ledger refused our credentials', 'Restart the dev server so it signs a fresh token.'],
  [/deadline_exceeded|timed? ?out|timeout/i, 'The ledger took too long to answer', 'It may still settle. Check Activity in a moment before retrying.'],
  [/duplicate_command/i, 'Already submitted', 'The same command is still being processed.'],
  [/contract_not_found|could not be found|inactive_contracts|locked_contracts|contract.*(archived|consumed)/i, 'Something changed while you were signing', 'Another transaction used these funds first. The page has refreshed, so try again.'],

  // the operator never picked the order up
  [/not settled yet|did not settle this request/i, "It didn't settle", 'If the price moved past your minimum, your funds went back to you.'],

  // slippage and price moves
  [/slippage|output above the pool's quote/i,'The price moved past your limit', 'Nothing was spent. Allow a little more slippage or try a smaller amount.'],
  [/conversion needs more than the buyer's maximum/i, 'The price moved past your limit', 'The conversion needed more than you allowed. Nothing was spent.'],

  // balances
  [/insufficient balance for payroll|no funds left for payroll/i, "The treasury can't cover this payroll", 'Add USDx to the employer, or lower the pay lines.'],
  [/insufficient funds to settle advances/i, "Payday can't cover the open wage advances", 'Add USDx to the employer before running payroll.'],
  [/insufficient collateral balance/i, 'Not enough Canton Coin to lock as collateral', 'Lock less, or top up CC from Holdings.'],
  [/insufficient balance to repay|repayment does not cover what is owed/i, "That doesn't cover what is owed", 'Interest keeps accruing; top up USDx and repay again.'],
  [/insufficient (balance|funds)|no (input )?holdings|no holdings given/i, 'Not enough balance', 'Lower the amount, or top up from the faucet in Holdings.'],

  // credit
  [/borrow exceeds the collateral's limit/i, "That's more than your collateral allows", 'You can borrow up to 60% of the collateral’s value.'],
  [/not enough (idle )?cash|market has no cash/i, "The market doesn't have that much USDx right now", 'Borrow less, or wait for lenders to supply more.'],
  [/loan is healthy/i, 'This loan is healthy', 'It can only be liquidated once its health drops below 1.'],

  // wage advances
  [/above the advance limit/i, "That's above your advance limit", 'Ask your employer to raise the limit, or take less.'],
  [/one open advance per pay period/i, 'You already have an advance this pay period', 'It is repaid automatically on payday.'],
  [/advance larger than the employee's pay/i, 'The advance is larger than the pay', 'Take less than this period’s net pay.'],

  // input checks and expiries
  [/must be positive|positive amount|amount must be > 0/i, 'Enter an amount above zero'],
  [/deposit too small/i, 'That deposit is too small for the pool'],
  [/deadline passed|transfer expired|expired/i, 'This request expired', 'Nothing was moved. Start it again.'],
  [/did not complete the allocation immediately/i, "The Canton Coin registry didn't settle right away", 'Try again in a moment.'],
  [/another registry or instrument|unknown instrument|wrong (asset|collateral asset|registry admin)|not in this pool/i, "These funds can't be used here", 'They belong to a different instrument or registry.'],
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
