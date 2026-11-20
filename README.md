# Orvane

A private exchange on the Canton Network, where liquidity never leaves your wallet.

Orvane is a constant-product DEX built on the Canton Network Token Standard V2 (CIP-0112) and
written in Daml. It does two things, and tries to do them better than anyone else on Canton:

- **Private swaps.** You sell an exact amount for at least the minimum you set, in one atomic
  transaction. Only you and the operator can see the trade. The providers on the other side never
  learn who you are, and you never learn who they are.
- **Self-custodial liquidity.** Providers never hand their funds to a pool. Their deposit stays in
  their own account, locked for a term they choose, and every swap settles a slice of it. They can
  withdraw whenever they like. When the term ends, the funds unlock without anyone's help, even if
  Orvane is gone.

Status: working end to end on Canton LocalNet (Splice 0.10.2), with real Canton Coin and Splice's
official V2 test token, through the official Wallet Gateway. Not audited. Read
[SECURITY.md](SECURITY.md) for the trust model.

## Why this design

| | Typical Canton AMM | Orvane |
|---|---|---|
| Where LP funds sit | In the operator's or the pool's custody | In the LP's own account, locked by the token standard |
| If the operator disappears | LPs depend on it to get funds back | Funds unlock on their own at the end of the term |
| Who sees a trade | Trader, operator, and often the counterparties | Trader and operator only: every leg runs through the operator |
| How LPs are paid | An LP token to redeem later | Their own allocation grows with the fees, on every swap |
| Asset support | Often one integration per token | Any CIP-0112 asset; Canton Coin and the test token run the same code |

## How it works

### Liquidity

A provider signs one transaction at the pool's `OrderDesk`. It creates two **committed, iterated
V2 allocations** in the provider's own account, one per asset, with the operator as executor and the
term end as deadline. The operator opens a position on them (`PoolRules_AddLiquidity`) after checking
the amounts, the term and that the deposit matches the pool price.

```
Provider --one signature--> OrderDesk_Deposit
                             ├─ AllocationFactory_Allocate   asset A, committed, locked until term end
                             ├─ AllocationFactory_Allocate   asset B, committed, locked until term end
                             └─ DepositRequest               (provider + operator)
Operator --opens-->          PoolRules_AddLiquidity          LpPosition (provider + operator), reserves += A, B
```

Committed means the provider can't pull the funds out from under a swap mid-term. They can still
leave at any time through the operator (`WithdrawRequest`), and at the deadline the token standard
lets them withdraw on their own. Canton Coin also expires the allocation at its deadline, so it
unlocks with no action at all. Renewing a position re-locks the same amounts for a new term in one
transaction.

### Swaps

A trader signs one transaction at the `OrderDesk`: it locks exactly the input in an allocation whose
only leg is trader → operator, and files a `SwapRequest`. The operator fills it in one transaction:

```
Operator --PoolRules_Swap--> checks every position (in term, allocations match the books)
                             prices with x*y=k and a 0.30% fee, refuses anything below the trader's minimum
                             SwapRequest_Fill            the trader's receipt allocation, for exactly the output
asset A batch:  SettleBatch  trader → operator → each LP, pro rata to what they hold of A
asset B batch:  SettleBatch  each LP → operator → trader, pro rata to what they hold of B
                             every LP allocation rolls into its next iteration with its new amount
                             SwapReceipt (trader + operator), PoolState updated
```

The operator stands in the middle of every leg with an allocation that nets to zero, so no trader
ever appears in an LP's allocation and no LP in a trader's. If the price moved past the trader's
minimum, the swap is handed back and the input unlocked in the same transaction.

Wallets of external parties can only sign transactions with a single root action, which is why
orders are one choice on the operator's `OrderDesk` contract, handed to the wallet as a disclosed
contract. The desk's choices still need the user's own signature.

### Who sees what

| | You | Other traders | Other LPs | Operator | Public |
|---|---|---|---|---|---|
| That you traded, and how much | yes | no | no | yes | no |
| Your liquidity position | yes | no | no | yes | no |
| Who was on the other side | no | no | no | yes | no |
| Pool reserves and recent prices | yes | yes | yes | yes | yes |

As with any token, an asset's registry also sees transfers of its own asset. The **Privacy** tab
shows it live: what your node holds next to what everyone else can learn, and a check from your own
allocations that the only counterparty they name is the operator.

## Repository layout

| Path | What |
|---|---|
| `daml/orvane/` | The contracts: `Orvane.Dex.Pool` (rules, swap, liquidity), `Orders` (desk and requests), `State`, `Token` (V2 helpers), `Math` |
| `daml/orvane-test/` | Daml Script tests against Splice's official V2 test token |
| `daml/dars/` | Official token-standard V2 API packages and the V2 test token, from the Splice 0.10.2 bundle |
| `config/pairs.localnet.json` | Network and pools: pairs, fee, terms, limits |
| `operator/` | The executor: sets up pools, settles requests, serves the public API and the registry proxy |
| `shared/` | Ledger client, exact Daml-decimal math, DEX commands, V2 registry clients (Scan and the test token) |
| `frontend/` | React app: CIP-0103 wallets (Wallet Gateway, Loop), Swap, Liquidity, Portfolio, Privacy |
| `scripts/` | LocalNet, Wallet Gateway, test funds, the end-to-end check |

## Running it on LocalNet

You need Docker Desktop (about 11 GB of memory), Node 22.18+, and [dpm](https://docs.digitalasset.com)
with Daml SDK 3.7.3. Download the Splice node bundle
([releases](https://github.com/digital-asset/decentralized-canton-sync/releases), 0.10.2) and set
`ORVANE_SPLICE_DIR` to its `splice-node` folder.

```powershell
# 1. LocalNet and the Wallet Gateway (http://localhost:3030)
./scripts/localnet.ps1 up
./scripts/wallet-gateway.ps1 up

# 2. Contracts
cd daml; dpm build --all; cd ..

# 3. Operator: uploads the packages, opens the pools from config/, settles (http://localhost:7600)
node operator/index.ts

# 4. Web app (http://localhost:5173)
cd frontend; npm install; npm run dev
```

Then, once per wallet:

```powershell
# a ledger user for the wallet to sign in as (Client ID; Client Secret on LocalNet is "unsafe")
./scripts/wallet-gateway.ps1 user my-wallet
```

Connect in the app with **Connect wallet → Wallet Gateway** and sign in with that Client ID. Test funds
arrive as token-standard transfer offers, which you accept under **Portfolio → Incoming**:

```powershell
./scripts/fund-localnet.ps1 -Party <your party id> -Usd 100 -Cc 20000
```

`./scripts/localnet.ps1 stop` pauses LocalNet and keeps its data; `up` resumes it.

## Tests

```powershell
./scripts/test.ps1              # Daml: builds everything and runs the Daml Script suite
node scripts/e2e-localnet.ts    # LocalNet, with the operator running
```

The Daml suite runs against real V2 allocations of Splice's test token: deposits and their limits,
swaps both ways, trader protection (minimum, stale quotes, exact legs enforced by the registry,
nobody ordering for someone else), withdrawals, renewals, term ends with and without the operator,
pausing, privacy, and the books balancing over seeded runs of swaps (`x*y` never shrinks, supply is
conserved, every position's share holds).

The end-to-end check puts providers and a trader on a different participant from the operator,
as real wallets are. It funds them through transfer offers, deposits, swaps both ways, withdraws,
renews, and checks rejections, the books and privacy after each step, with real Canton Coin.

On a Turkish (or other dotted-i) system locale the Daml tools need an English JVM locale; the test
script sets `JAVA_TOOL_OPTIONS=-Duser.language=en -Duser.country=US`.

## Roadmap

1. Contracts on Token Standard V2 with self-custodial liquidity (done)
2. Operator with exact settlement, rejections that release funds, and term handling (done)
3. Web app with CIP-0103 wallets; tested with the Wallet Gateway on LocalNet (done)
4. DevNet: real V2 pairs, and the [Loop](https://docs.fivenorth.io/loop-sdk/overview/) wallet once
   Five North has reviewed the package
5. Remove the remaining operator trust: a second executor that co-signs every settlement, or
   settlement only through the pool contract (see [SECURITY.md](SECURITY.md))

## Acknowledgements

The token-standard API packages and the V2 test token in `daml/dars/` are from
[Splice](https://github.com/hyperledger-labs/splice) (Apache-2.0), as published in its 0.10.2
release bundle.

## License

Apache-2.0, see [LICENSE](LICENSE).
