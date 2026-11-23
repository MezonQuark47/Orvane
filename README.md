# Orvane

Swap any Canton token from your own wallet, priced and checked before you sign.

Orvane is a swap app for the Canton Network. The liquidity is [Cantex](https://cantex.io)'s, the
deepest pools on Canton, reached through Cantex's public Connect API. Everything a user touches is
Orvane's own work: market data, an independent quote check, the guard that re-prices right before
signing, the wallet integration, fill tracking and the portfolio. **No account and no Orvane fee.**

Status: running against Cantex on **Canton TestNet** (and MainNet's API) with live data. Quoting,
Orvane's own pricing check and the guard are verified against Cantex's live API. Swaps are signed
through Five North's Loop wallet; the first live Loop swap on TestNet is the next step. Not audited;
read [SECURITY.md](SECURITY.md).

## What Orvane adds on top of Cantex's pools

| | |
|---|---|
| **Own pricing check** | Every quote is recomputed from the pools' public reserves with Cantex's fee rules and compared with Cantex's own quote. Verified against every quotable pair on TestNet and MainNet (`scripts/smoke-cantex.ts`). |
| **Price guard** | Cantex fills at the pool price when the transfer arrives and its quote is not binding. Orvane quotes again right before asking for a signature and sends nothing if the price moved past the user's limit. The transfer is valid for 15 minutes, so it cannot be filled later at a price nobody checked. |
| **Market sanity** | The pool's price is shown next to Canton Coin's market price; a pool far off the market is flagged before you trade into it. |
| **Readiness checks** | Balance, Cantex's minimum size, the price impact (above 5% the user accepts it, above 30% Orvane refuses the swap), and whether the wallet can receive the output token in one step (a transfer pre-approval for that token), before the wallet is asked to sign. |
| **Fill tracking** | Watches the user's own balance until the output lands; a swap Cantex has not filled shows up as pending, with what to do about it, and settles in the history when the output arrives later. A swap the wallet never confirmed (it timed out) is not shown as failed: it is watched until its transfer would have expired. |
| **Wallets** | Loop (TestNet, MainNet) swaps any listed token today. CIP-0103 browser wallets and the Wallet Gateway connect and show the portfolio; for swaps they need a registry endpoint per token (roadmap). Orvane never holds keys and reads only the user's own contracts, through their wallet. |
| **Portfolio** | Every holding valued at live pool prices, pending and incoming transfers, and Loop's USDCx-to-Ethereum bridge. |
| **Live market** | Prices and candles over Cantex's public websocket; quotes refresh every 5 seconds with a freshness indicator. |
| **Orvane's proxy** | Where it is set up, the swap's transfer runs through Splice's `WalletUserProxy`, so Orvane's party confirms it and can earn featured-app rewards from the network (below). Same transfer, same fees for the user. |

## How a swap works

```
Orvane   quote ──► Cantex /connect/quote          route, fees, expected output
         check ──► recompute from /pools/state     must match Cantex's quote
User     sets amount and price limit
Orvane   quote again + check again                 refuses if the price moved past the limit
Wallet   one transfer: sell token ──► cantex-swap::…   memo = the token to receive
         (through Orvane's proxy where it is set up)
Cantex   fills it from its pools, sends the output back to the wallet
Orvane   watches the wallet's balance until it lands
```

Fees are Cantex's: the pools' fee, Cantex's 0.20% Connect fee and a small network fee in Canton Coin
(0.1 CC on TestNet). Cantex's minimum is 50 CC or the equivalent. Orvane adds nothing.

## Orvane's proxy and featured-app rewards

The Canton Network pays app rewards to featured apps. Under traffic-based app rewards (CIP-0104,
approved October 2026, switch on MainNet planned for 2027), the traffic fee of a transaction a user
submits is shared as app activity among the featured apps that confirm it. Orvane takes part by
running the swap's transfer through Splice's own `WalletUserProxy` (package
`splice-util-featured-app-proxies`, by Digital Asset):

- the user's wallet signs one exercise on a proxy contract Orvane signs; inside it runs exactly the
  token-standard transfer the wallet prepared, nothing else (`shared/proxy.ts` refuses any other
  command);
- Orvane's party is a confirmer of the transaction, so its node sees the swap (who, which token,
  how much); Orvane pays no fee for it and holds nothing;
- no activity markers are created: under today's marker rules a non-wallet app may only mark its own
  traffic.

`scripts/proxy-setup.ts` loads the package, makes Orvane's party a featured app (on LocalNet and
DevNet, where a party may feature itself; on TestNet and MainNet that is the Featured App
application), creates the proxy and publishes it to `frontend/public/orvane-proxy.<network>.json`.
It logs in to a real validator with OAuth 2.0 client credentials; [DEPLOY.md](DEPLOY.md) has the
steps. `scripts/e2e-proxy.ts` checks it on LocalNet. On
TestNet and MainNet the app sends plain transfers until Orvane's party runs on a validator there and
the user's wallet has the proxy package loaded; if the wallet cannot run the proxy, the swap falls
back to a plain transfer before anything is signed.

## Running it

```powershell
cd frontend
npm install
npm run dev            # Canton TestNet, http://localhost:5173
npm run dev:mainnet    # Canton MainNet
```

There is no Orvane server on the swap path: the app talks to Cantex's public API and to the user's wallet. To swap
on TestNet you need a [Loop](https://docs.fivenorth.io/loop-sdk/overview/) TestNet wallet with some
test Canton Coin, and receiving turned on (a transfer pre-approval) for the token you buy.

Putting the site online (Vercel) and setting up Orvane's validator are in [DEPLOY.md](DEPLOY.md).

## Tests

```powershell
node --test shared/*.test.ts         # pricing check, proxy wrapper, swap settling, ledger login
node scripts/smoke-cantex.ts         # every TestNet pair, live
node scripts/smoke-cantex.ts mainnet # every MainNet pair, live
node scripts/proxy-setup.ts; node scripts/e2e-proxy.ts   # Orvane's proxy on LocalNet
./scripts/test.ps1                   # the above unit tests plus the Daml suite of the Orvane pool
```

## Repository layout

| Path | What |
|---|---|
| `shared/cantex.ts` | Cantex's public API: tokens, pools, quotes, websocket market data |
| `shared/quote.ts` | Orvane's own pricing check, the price guard, market deviation |
| `shared/proxy.ts` | Orvane's transfer proxy: wraps the wallet's transfer, nothing else |
| `shared/networks.ts` | TestNet / MainNet / LocalNet settings, Cantex endpoints and swap parties |
| `frontend/src/swap/` | Market data provider, swap execution and fill tracking, local swap history |
| `frontend/src/ledger/` | Wallets (Loop, CIP-0103 browser wallets, Wallet Gateway) and reading the user's node |
| `frontend/src/pages/` | Swap, Portfolio, the landing page |
| `daml/`, `operator/`, `config/` | The Orvane pool, kept for later (below) |

## The Orvane pool (kept for later)

Before routing through Cantex, Orvane built its own pool on Token Standard V2 with self-custodial
liquidity: providers' funds stay in their own accounts in committed allocations, every swap settles
pro rata against all of them through the operator, and funds return on their own at the end of a
term. It works end to end on LocalNet (real Canton Coin, Wallet Gateway wallets, a live term-end test
with the operator off) and is kept in the repository, switched off outside LocalNet:

```powershell
./scripts/localnet.ps1 up; ./scripts/wallet-gateway.ps1 up
cd daml; dpm build --all; cd ..
node operator/index.ts
cd frontend; npm run dev:localnet
```

Its contracts, tests and trust model are described in [SECURITY.md](SECURITY.md#the-orvane-pool-localnet-kept-for-later).
On a Turkish (or other dotted-i) system locale the Daml tools need an English JVM locale; the test
script sets it.

## Roadmap

1. Swap app on Cantex liquidity with Orvane's own pricing check and guard (done, TestNet)
2. Loop end-to-end swaps on TestNet, then MainNet
3. Other CIP-0103 wallets on TestNet/MainNet: needs a registry endpoint for each token (Scan is
   allowlisted), which a validator node's Scan proxy provides
4. A minimum-output guarantee as soon as Cantex Connect supports one (requested)
5. Orvane's proxy on TestNet/MainNet (an Orvane validator, the proxy package on Loop's nodes), then
   a Featured App application

## Acknowledgements

Liquidity: [Cantex](https://docs.cantex.io) by CaviarNine, through its public Connect API. Orvane is
an independent app and not affiliated with Cantex. The token-standard API packages and the V2 test
token and `splice-util-featured-app-proxies` in `daml/dars/` are from [Splice](https://github.com/hyperledger-labs/splice) (Apache-2.0).

## License

Apache-2.0, see [LICENSE](LICENSE).
