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

Packages:

- `daml/orvane-amm`: the on-ledger contracts (`Token`, `Pool`, `LpShare`, `SwapRequest`,
  `AddLiquidityRequest`, `RemoveLiquidityRequest`, `SwapReceipt`)
- `daml/orvane-amm-test`: Daml Script tests, kept in a separate package so test code is never
  uploaded to a validator

Design notes:

- Every user action is a propose/accept: the user signs a request and the operator settles it.
  Users never need to see each other's contracts.
- Disclosing a token to the operator lets the operator see it, not move it. Moving it still
  requires the owner's signed request (covered by a test).
- Pool choices don't include the trader, so members watching the pool learn the price but not
  the counterparty.
- If a liquidity deposit doesn't match the pool ratio, the excess is refunded.

## Running the tests

You need [dpm / Daml SDK 3.7.3](https://docs.digitalasset.com) and Java 17 or newer.

```bash
# Windows
./scripts/test.ps1

# macOS / Linux
./scripts/test.sh
```

All 8 scripts should pass.

| Test | Checks |
|---|---|
| `test_math` | sqrt, pricing and deposit ratio |
| `test_addLiquidity` | first and later deposits, excess refund |
| `test_swap` | output amount, k never decreases, another member can't see the trade |
| `test_slippageProtection` | trade is rejected and the trader keeps their funds |
| `test_foreignTokenRejected` | a same-named token from another issuer is rejected |
| `test_operatorCannotStealWithoutRequest` | the operator can't move disclosed funds |
| `test_removeLiquidity` | LP withdraws reserves plus earned fees |

## Roadmap

1. Private AMM: swap, liquidity, LP shares (done)
2. Web app: React with [Loop SDK](https://docs.fivenorth.io/loop-sdk/overview/) wallet connection
3. Operator service that settles requests through the Ledger API
4. DevNet deployment with Canton Coin and CIP-56 token standard assets
5. Payments: private B2B payments and payroll batches settled through the pool
6. Lending: collateralized credit lines and earned-wage advances funded by pool liquidity

## License

Apache-2.0, see [LICENSE](LICENSE).
