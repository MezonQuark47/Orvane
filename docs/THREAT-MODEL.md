# Threat model

What Orvane protects, whom it trusts, and what an audit should look at. It covers the two parts of
Orvane:

- **the swap app** (TestNet, MainNet, DevNet): a front end that sends a wallet's transfer to a venue,
  optionally through Orvane's proxy, and
- **the Orvane pool** (`daml/orvane`, LocalNet for now): self-custodial liquidity on token standard V2
  allocations.

## Assets

| Asset | Where it lives |
|---|---|
| Users' tokens | The user's own wallet and validator. Orvane never holds them. |
| Liquidity providers' tokens (pool) | Committed allocations in the provider's own account, with the operator as the executor. |
| Orvane's featured party and its rewards | Orvane's validator. |
| The OneSwap integrator key | Vercel env var, read only by `api/oneswap.ts`. |
| Ledger API client credentials | Env vars on the machine that runs the operator or the setup scripts. Never in files. |

## Trust assumptions

1. **Users trust their wallet** to show the transfer they sign. Orvane cannot sign for them.
2. **Users trust the venue** (Cantex, OneSwap) to fill the transfer they sent. Orvane checks the quote
   against the pools' public reserves before it lets the user sign (`shared/quote.ts`). It cannot
   force the venue to fill.
3. **Pool providers trust the operator** for liveness and fair ordering. The operator is the only
   signatory of the pool's contracts and the executor of the providers' allocations. The contracts
   limit what it can do:
   - a swap settles only legs that the trader's allocation names, at or above the trader's
     `minOut` (checked in `SwapRequest_Fill`, which the trader signed);
   - `x * y` never goes down, and the pool's books must equal the sum of the positions;
   - at the end of the term the registry hands the funds back without the operator.

   Within those limits the operator could still order swaps in its own favour or refuse to serve
   someone. Being the only signatory, it could also create pool state the rules don't expect. A
   multi-party operator, or the providers as observers of each `PoolState`, would reduce this.
4. **The proxy cannot change a transfer.** `WalletUserProxy_BatchTransfer` runs exactly the factory
   call the user signed. `shared/proxy.ts` refuses to wrap anything other than one V1
   `TransferFactory_Transfer`.

## Threats and mitigations

| Threat | Mitigation | Status |
|---|---|---|
| Front end served with altered code (hosting or dependency compromise) | Strict CSP (`'self'` only, no CDNs). Lockfile. The wallet shows the real transfer. | In place. Add dependency auditing to CI. |
| Quote manipulation: a venue fills far worse than shown | Two independent price checks. Above 5% impact needs the user's OK; above 30% is refused. The user's own minimum. | In place (`shared/quote.ts`, tests). |
| Stale quote | Re-quoted at Swap time. The swap deadline and the transfer TTL (15 min). | In place. |
| Integrator key leak | Key only on the server. The forwarder passes an allow-list of calls. | In place (`api/oneswap.ts`). Add rate limiting. |
| Ledger credentials leak | Env vars only. The well-known LocalNet secret is refused on real networks. | In place (`operator/network.ts`). |
| Pool: one expired position stops all swaps | The swap closes expired positions on the way. | Fixed in 0.2.0, tested. |
| Pool: operator settles a provider's allocation wrongly | The allocations carry fixed terms (`checkFunding`). The provider-side legs are computed pro rata in the contract. The books are checked after each swap. | In place, tested. |
| Pool: contention and one swap at a time | One `PoolState` per pool. At most 20 positions. | Known limit. Fine for LocalNet and DevNet. |
| Pool: a registry returns a pending allocation | Refused (`allocate` in `Token.daml`); the swap fails as a whole. | In place. |
| Reward abuse (wash trading, batching to farm rewards) | No incentives for volume. No markers created. Monitoring of activity jumps. | Policy. See `docs/FEATURED-APP.md`. |
| Featured party key loss | Recovery plan; co-validation by 2+ validators (asset-moving tier). | Not started. |
| Privacy: who traded with whom | The pool operator sits in the middle of every leg. The app keeps history in the browser only. | In place. |

## Audit scope (proposal)

1. `daml/orvane` (Pool, Orders, Token, Math, State) with `daml/orvane-test`.
2. `shared/quote.ts`, `shared/proxy.ts`, `shared/settle.ts`, and the swap flow in
   `frontend/src/swap/execute.ts` and `frontend/src/ledger/wallet.ts`.
3. `api/oneswap.ts`, the CSP and the hosting setup (`vercel.json`).
4. The operator (`operator/`), if the pool goes beyond LocalNet.
