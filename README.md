# Orvane

Private payments and DeFi on the Canton Network, written in Daml.

Orvane is an open-source settlement layer for businesses that want to trade, pay and borrow
on-ledger without exposing who paid whom or how much they hold.

Status: early prototype. Module 1 (a private AMM) is done. Payments (B2B, payroll, stablecoin
transfers) and collateralized lending will be built on top of the same liquidity pool. See the
roadmap below.

## Why Canton

On most public chains every swap and every payment is visible to everyone. Canton has
sub-transaction privacy: a party only sees the parts of a transaction it is a stakeholder in.
Orvane relies on this:

| Party | Can see |
|---|---|
| Pool members | Pool reserves (i.e. the price), nothing else |
| Trader | Their own request, tokens and receipt |
| Operator | The requests it has to settle |
| Other traders | Neither who traded nor what anyone holds |

A trade settles in a single Canton transaction (input in, pool update, output out, receipt),
so it either fully happens or doesn't happen at all.

## How a swap works

```
Trader   --signs-->    SwapRequest            (visible to trader + operator)
Operator --executes--> SwapRequest_Execute    (one atomic transaction)
    1. Token.Transfer  trader -> operator     (authorized by the trader's request)
    2. Pool_Swap       x*y=k, 0.30% fee, slippage check, no trader identity
    3. Token.Transfer  operator -> trader
    4. SwapReceipt     visible to trader + operator only
```

Wallets only ever sign one command per action: `SwapOrder_Place` / `LiquidityOrder_Place` merge
the user's holdings, carve out the exact amount, disclose it to the operator and file the request
in a single transaction.

## Repository layout

| Path | What it is |
|---|---|
| `daml/orvane-amm` | On-ledger contracts: `Token`, `Pool`, `LpShare`, `SwapOrder`, `SwapRequest`, `LiquidityOrder`, `AddLiquidityRequest`, `RemoveLiquidityRequest`, `SwapReceipt` |
| `daml/orvane-amm-test` | Daml Script tests, kept in a separate package so test code is never uploaded to a validator |
| `shared/` | TypeScript JSON Ledger API v2 client, contract types, command builders and pricing math, used by both the operator and the web app |
| `operator/` | Node service that bootstraps a demo pool and settles requests (no dependencies, Node 22.18+) |
| `frontend/` | React web app: React Three Fiber scene, Motion, Radix UI, Five North Loop SDK |

Design notes:

- Every user action is a propose/accept: the user signs a request and the operator settles it.
  Users never need to see each other's contracts.
- Disclosing a token to the operator lets the operator see it, not move it. Moving it still
  requires the owner's signed request (covered by a test).
- Pool choices don't include the trader, so members watching the pool learn the price but not
  the counterparty.
- If a liquidity deposit doesn't match the pool ratio, the excess is refunded.

## Running the app locally

You need [dpm / Daml SDK 3.7.3](https://docs.digitalasset.com), Java 17 or newer and Node 22.18 or newer.
Use three terminals:

```bash
# 1. Canton sandbox with the contracts loaded (JSON Ledger API on :6864)
./scripts/sandbox.ps1

# 2. Operator: creates parties, a seeded USDx/CCx pool, and settles requests (:7600)
cd operator && npm start

# 3. Web app (http://localhost:5173)
cd frontend && npm install && npm run dev
```

In the app, use "Act as" to switch between Alice (liquidity provider), Bob (trader) and Carol
(pool member). The Privacy lens tab shows, live, which contracts each of them can see.
The sandbox is in-memory, so restarting it resets the demo.

## Running the tests

You need [dpm / Daml SDK 3.7.3](https://docs.digitalasset.com) and Java 17 or newer.

```bash
# Windows
./scripts/test.ps1

# macOS / Linux
./scripts/test.sh
```

All 11 scripts should pass.

| Test | Checks |
|---|---|
| `test_math` | sqrt, pricing and deposit ratio |
| `test_addLiquidity` | first and later deposits, excess refund |
| `test_swap` | output amount, k never decreases, another member can't see the trade |
| `test_slippageProtection` | trade is rejected and the trader keeps their funds |
| `test_foreignTokenRejected` | a same-named token from another issuer is rejected |
| `test_operatorCannotStealWithoutRequest` | the operator can't move disclosed funds |
| `test_removeLiquidity` | LP withdraws reserves plus earned fees |
| `test_swapOrderSingleSignature` | one signature merges holdings, swaps the exact amount, change stays private |
| `test_swapOrderInsufficientBalance` | ordering more than you hold fails |
| `test_liquidityOrder` | one-signature deposit mints an LP share |

## Roadmap

1. Private AMM: swap, liquidity, LP shares (done)
2. Web app: React with [Loop SDK](https://docs.fivenorth.io/loop-sdk/overview/) wallet connection (done, local sandbox)
3. Operator service that settles requests through the Ledger API (done, local sandbox)
4. DevNet deployment with Canton Coin and CIP-56 token standard assets
5. Payments: private B2B payments and payroll batches settled through the pool
6. Lending: collateralized credit lines and earned-wage advances funded by pool liquidity

## License

Apache-2.0, see [LICENSE](LICENSE).
