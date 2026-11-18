# Orvane

Private payments and DeFi on the Canton Network, written in Daml.

Orvane is an open-source settlement layer for businesses that want to trade, pay and borrow
on-ledger without exposing who paid whom or how much they hold.

Status: prototype on a local Canton sandbox. Three modules share one liquidity pool:

- **Private AMM**: swaps and liquidity where nobody but the trader and operator sees a trade.
- **Private payments**: payroll and B2B invoices. Employees see only their own payslip, the
  auditor sees totals only, and anyone can pay or be paid in the currency they prefer, with the
  conversion settled atomically through the pool.
- **Private lending**: collateralized USDx loans against CCx, priced and liquidated through the
  pool, plus earned-wage advances that are repaid automatically out of the next payroll.

Next: DevNet deployment with the Loop wallet. See the roadmap below.

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

## How payments work

**Payroll.** The employer signs one `PayrollOrder_Run`. In that transaction every employee paid
in the payroll currency gets their funds and a `Payslip` that only they (and the employer) can
read, and the auditor gets a `PayrollAttestation` with period, headcount and total. Employees
who asked to be paid in another currency (`PayoutPreference`) get a `PayoutRequest` that the
operator settles through the pool. The operator only ever sees those lines. If the conversion
can't be filled within the employer's slippage limit, the employee is paid in the original
currency instead, so nobody goes unpaid.

**Invoices.** A supplier's `Invoice` is visible to the supplier and buyer only. Paying in the
invoice currency settles directly between the two of them. Paying in another currency creates an
`InvoiceSettlement`; the operator swaps exactly enough to cover the invoice, the supplier
receives the exact invoiced amount, and unused input goes back to the buyer. Buyers can dispute,
suppliers can reissue.

| Party | Can see |
|---|---|
| Employee | Their own payslips and payout preference |
| Auditor | Payroll totals (period, headcount, sum), no names or amounts |
| Operator | Only payroll lines and invoices that need a currency conversion |
| Supplier / buyer | Their shared invoices and payment proofs |

## How lending works

**Market.** Lenders supply USDx and receive shares whose value grows as borrowers pay interest.
The borrow rate follows utilization (2% base + 18% × utilization). Members see the market's
totals; market choices never carry a lender's or borrower's identity.

**Loans.** A borrower locks CCx and borrows up to 60% of its value, priced from the AMM pool.
The loan is visible to the borrower and the operator only. Repaying is a single signature that
returns the collateral in the same transaction. If debt crosses 80% of the collateral's value,
the operator's keeper liquidates: the collateral is sold through the pool and the market is
repaid in one atomic transaction. Any shortfall is recorded as bad debt, never hidden.

**Earned-wage advances.** The employer opens an `AdvanceLine` per employee. The employee draws an
advance from the lending market (1% fee). At the next payroll, `PayrollWithAdvances` repays every
open advance and pays everyone their net amount, all under the employer's one signature.
Colleagues and lenders never see who took an advance.

The demo market runs on a compressed clock (one year of interest per hour, set by
`yearSeconds`) so interest is visible while you watch.

## Real Canton Coin: token-standard exchange

On LocalNet, Trade runs against a USDx / **Canton Coin** pool that settles exclusively through the
Canton Network Token Standard (CIP-56). The exchange contract never touches a token
implementation; it only sees `Allocation`s, so Canton Coin (Amulet, registry served by Scan) and
Orvane USDx (our own registry) are handled by the same code.

```
Trader   --one signature-->  ExchangeSwapOrder_Place
                              ├─ AllocationFactory_Allocate   (CC locked: trader -> operator, executor operator)
                              └─ ExchangeSwapRequest          (visible to trader + operator)
Operator --allocates-->       output from the pool's reserves (operator -> trader)
Operator --settles-->         ExchangeSwapRequest_Settle, one atomic transaction:
                              ├─ ExchangePool_Swap            (x*y=k accounting, can't pay above the quote)
                              ├─ Allocation_ExecuteTransfer   (input leg)
                              └─ Allocation_ExecuteTransfer   (output leg)
```

Choice contexts and disclosed contracts (AmuletRules, open mining round) come from the registry's
off-ledger API and are passed through untouched. If a trade can't be filled, the operator cancels
the trader's allocation and the funds are released.

### Payroll on the token standard

```
Employee --signs once-->  PayeeConsent              (employer may pay me; operator may convert my pay)
Employer --one signature-> PayrollOrderCn_Lock       (every line becomes an allocation; each employee sees only theirs)
Employer --payday-->       PayrollBatch_Release      (all allocations execute atomically under the consents)
                           ├─ PayslipCn              (signed by employer + employee, nobody else)
                           ├─ PayrollAttestationCn   (auditor: period, headcount, total)
                           └─ ConvertTicket          (only for employees who want Canton Coin)
Operator                   ConvertTicket_Swap        (swaps the pay through the exchange with the employee's authority)
```

The operator never sees a payroll line unless that employee asked for a conversion, and it can't
sell more than the pay that was just received.

### Credit on the token standard

Every movement of funds is an allocation, settled as one atomic DvP by the operator:

| Action | Legs (one transaction) |
|---|---|
| Supply | USDx lender → operator; position minted |
| Borrow | CC borrower → operator **and** USDx operator → borrower; loan created |
| Repay | USDx borrower → operator **and** CC operator → borrower; loan closed |
| Withdraw | USDx operator → lender; position burned |
| Liquidate | on-ledger only: the loan's CC is sold into the exchange pool and the market repaid; any surplus is paid back to the borrower |

Collateral is priced by the exchange pool. Loans and positions are visible to their owner and the
operator only; market choices never name a party.

## Repository layout

| Path | What it is |
|---|---|
| `daml/orvane-amm` | On-ledger contracts: `Token`, `Pool`, `LpShare`, `SwapOrder`, `SwapRequest`, `LiquidityOrder`, `AddLiquidityRequest`, `RemoveLiquidityRequest`, `SwapReceipt` |
| `daml/orvane-payments` | Payroll (`PayrollOrder`, `Payslip`, `PayrollAttestation`, `PayoutPreference`, `PayoutRequest`) and invoices (`Invoice`, `InvoiceSettlement`, `PaidInvoice`, `DisputedInvoice`). Depends on `orvane-amm` |
| `daml/orvane-lending` | Lending market (`LendingMarket`, `SupplyPosition`, `Loan`, borrow/supply orders) and wage advances (`AdvanceLine`, `Advance`, `PayrollWithAdvances`). Depends on both packages above |
| `daml/orvane-registry` | CIP-56 token registry for Orvane test instruments (USDx): `OrvaneHolding`, `OrvaneRules` (TransferFactory, AllocationFactory), `OrvaneAllocation`. Built on the official Splice token standard interfaces vendored in `daml/dars` |
| `daml/orvane-exchange` | Token-standard exchange: `ExchangePool`, `ExchangeSwapOrder` (allocate input + file request in one signature), `ExchangeSwapRequest` (atomic DvP settlement), `ExchangeReceipt` |
| `daml/orvane-treasury` | Token-standard payroll: `PayeeConsent` (employee-signed delegation), `PayrollOrderCn` (lock every line as an allocation), `PayrollBatch` (atomic release), `PayslipCn`, `PayrollAttestationCn`, `ConvertTicket` (convert pay through the exchange) |
| `daml/orvane-credit` | Token-standard credit: `CreditMarket`, supply / borrow / repay orders and requests (each one DvP), `CreditLoan` with on-ledger liquidation into the exchange pool, `CreditSurplus` |
| `daml/orvane-amm-test` | Daml Script tests, kept in a separate package so test code is never uploaded to a validator |
| `shared/` | TypeScript JSON Ledger API v2 client (with LocalNet dev JWT), contract types, command builders, pricing math, Scan / token-standard registry client (`amulet.ts`) and registry abstraction (`exchange.ts`). Used by both the operator and the web app |
| `operator/` | Node service that uploads the contracts, bootstraps a demo world and settles requests (no dependencies, Node 22.18+) |
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
Use three terminals. Two ledgers are supported: the lightweight `dpm sandbox`, or the full Splice
LocalNet (a local Canton Network with Canton Coin, wallets and Scan; needs Docker and ~10 GB RAM).

**Option A: sandbox (fast, ~2 GB RAM)**

```bash
# 1. Canton sandbox with the contracts loaded (JSON Ledger API on :6864)
./scripts/sandbox.ps1

# 2. Operator: uploads contracts, creates parties and the demo world, settles requests (:7600)
cd operator && npm start

# 3. Web app (http://localhost:5173)
cd frontend && npm install && npm run dev
```

**Option B: Splice LocalNet (full Canton Network)**

Download and unpack the Splice node bundle matching DevNet
([releases](https://github.com/digital-asset/decentralized-canton-sync/releases), currently 0.10.2)
and set `ORVANE_SPLICE_DIR` to its `splice-node` folder. Then:

```bash
# 1. Start LocalNet (first run pulls images; give Docker ~11 GB of memory)
./scripts/localnet.ps1 up

# 2. Build the contracts, then run the operator against the app-provider participant (:3975)
cd daml && dpm build --all && cd ..
cd operator && npm run start:localnet

# 3. Web app; the dev proxy signs LocalNet's development JWT, so no secret reaches the browser
cd frontend && npm run dev:localnet
```

LocalNet uses the `unsafe` HS256 development secret that ships with Splice. It is for local
development only. Wallet UIs: http://wallet.localhost:3000 (app provider), Scan: http://scan.localhost:4000.
`./scripts/localnet.ps1 down` stops it and deletes its data.

In the app, use "Act as" to switch between Alice (liquidity provider), Bob (trader), Carol
(pool member), Acme (employer and buyer), Nova (supplier) and the Auditor. The Privacy lens tab
shows, live, which contracts each of them can see.
The sandbox is in-memory, so restarting it resets the demo. On LocalNet the operator recognises an
existing demo world and does not seed it twice.

## Running the tests

You need [dpm / Daml SDK 3.7.3](https://docs.digitalasset.com) and Java 17 or newer.

```bash
# Windows
./scripts/test.ps1

# macOS / Linux
./scripts/test.sh
```

All 57 scripts should pass.

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
| `test_payrollSameCurrency` | one signature pays three people; each sees only their payslip, the auditor only the total |
| `test_payrollConversion` | a CCx line goes through the pool; the operator never sees the other lines |
| `test_payrollConversionFallback` | a failed conversion still pays the employee, in USDx |
| `test_payrollInsufficientFunds` | payroll larger than the balance is rejected |
| `test_invoicePaidDirect` | same-currency payment; operator and outsiders never see the invoice |
| `test_invoicePaidConverted` | buyer pays in CCx, supplier gets exactly the USDx invoiced, refund is private again |
| `test_invoiceConversionSlippage` | too-low maximum: invoice reopens, buyer keeps funds |
| `test_invoiceDisputeAndReissue` | dispute and corrected reissue |
| `test_supplyAndBorrowPrivately` | borrow within LTV; members see totals, the lender never sees the borrower |
| `test_borrowAboveLimitRejected` | borrowing past 60% LTV fails |
| `test_repayWithInterestAndLenderEarns` | a year of interest, collateral returned, lender withdraws principal + interest |
| `test_healthyLoanCannotBeLiquidated` | the operator cannot liquidate a safe loan |
| `test_liquidationThroughThePool` | price crash, collateral sold through the AMM, bad debt recorded |
| `test_addCollateral` | topping up collateral |
| `test_advanceRepaidFromPayroll` | advance drawn, then repaid out of payroll under one signature |
| `test_advanceLimits` | above-limit and second open advance are rejected |
| `test_mintExposesHoldingView` … `test_settlementDeadline` | registry conformance: Holding view, transfers, DvP with two allocations settled atomically, executor cannot settle alone, withdraw, deadlines |
| `test_swapSettlesAtomically` … `test_orderMustPayTheOperator` | exchange: atomic two-leg settlement, no overpaying from reserves, slippage reject releases funds, mismatched allocations and orders rejected, outsiders see nothing |
| `test_payrollLockAndRelease` … `test_cancelReturnsFunds` | token-standard payroll: lock and atomic release, per-employee privacy, auditor totals only, conversion through the exchange, operator cannot sell more than the pay, wrong consents rejected, cancel returns funds |
| `test_borrowIsAtomicAndPrivate` … `test_liquidationSellsCollateralIntoThePool` | token-standard credit: atomic borrow, LTV limit, repay returns collateral and lender earns, underpayment rejected and refunded, healthy loans safe, liquidation through the pool with bad debt recorded |

## Roadmap

1. Private AMM: swap, liquidity, LP shares (done)
2. Web app: React with [Loop SDK](https://docs.fivenorth.io/loop-sdk/overview/) wallet connection (done, local sandbox)
3. Operator service that settles requests through the Ledger API (done, local sandbox)
4. LocalNet deployment (done), CIP-56 registry for USDx (done), USDx / Canton Coin exchange settling
   through token-standard allocations (done), payroll on allocations with real CC conversion (done),
   credit with real CC collateral (done); next: invoices and wage advances on allocations, then DevNet
5. Payments: private payroll and B2B invoices settled through the pool (done, local sandbox)
6. Lending: collateralized loans with pool-priced liquidation and earned-wage advances (done, local sandbox)

## License

Apache-2.0, see [LICENSE](LICENSE).
