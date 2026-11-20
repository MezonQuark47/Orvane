# Security and trust model

Orvane is not audited. This page says what you trust when you use it, and what each party can see,
so you can judge it for yourself.

## Swaps through Cantex (TestNet, MainNet)

**What Orvane is.** A web app that runs in your browser. It has no server, no account and no
contracts on the swap path, and it never holds keys or funds. It reads market data from Cantex's
public API and your own contracts through your wallet.

**What a swap is.** One token-standard transfer from your wallet to Cantex's swap party
(`cantex-swap::…`), with the token you want back as the memo. Your wallet shows it and you sign it.
Cantex fills it from its pools and sends the output back to your wallet.

**What you trust Cantex for.** To fill the swap at its pool price and send the output back. Cantex
fills at the price in effect when your transfer arrives; its quote is not binding and Connect has
no minimum-output limit today. If Cantex cannot fill a swap, the transfer stays pending and your
wallet can withdraw it.

**What Orvane does about that.** Before asking for your signature it:

- recomputes the expected output from the pools' public reserves and refuses the swap if Cantex's
  quote does not match them (checked across every quotable pair on TestNet and MainNet);
- quotes again and refuses if the output fell below the limit you set;
- warns when the pool's price is far from Canton Coin's market price;
- checks your balance, Cantex's minimum and whether your wallet can receive the output token.

These checks run before signing. Between signing and Cantex's fill (usually a few seconds) the
price can still move; only a minimum-output field in Connect would close that gap, and Orvane has
asked Cantex for one.

**Swap parties.** MainNet: the party Cantex documents. TestNet: Cantex's party name in Cantex's
TestNet namespace, read from its pool proofs and marked as inferred in `shared/networks.ts` until
Cantex confirms it. A wrong id would make the transfer fail (no such party), not send funds elsewhere.

**Who sees what.** Orvane: nothing. Cantex: your transfer (party, token, amount) and the swap it
fills. The token's registry: transfers of its own token, as with any Canton token. Everyone else:
pool reserves, prices and aggregate volumes only. Your swap history is kept in your browser.

**Supply chain.** The wallet SDKs (Digital Asset's dApp SDK, Five North's Loop SDK) are pinned and
`npm audit` is clean; a vulnerable transitive `uuid` is overridden to a fixed version.

## The Orvane pool (LocalNet, kept for later)

Orvane's own pool runs only on LocalNet. The rest of this page describes it.

### Parties

| Party | Role |
|---|---|
| Trader | Sells an exact amount for at least a minimum. |
| Liquidity provider (LP) | Locks both assets of a pool for a term; earns the swap fee. |
| Operator | Runs the pool: the only executor of the pool's settlements. Holds no user funds. |
| Instrument admin (registry) | Issues an asset (the DSO for Canton Coin, the test-token admin on LocalNet). |

Orvane never holds anyone's keys. Every user action is signed in the user's own wallet (CIP-0103),
and the app reads a user's contracts through that wallet, never with ledger credentials of its own.

### What the contracts guarantee

**Traders** (`daml/orvane/daml/Orvane/Dex/Orders.daml`)

- The input is locked in an allocation that names one exact leg: trader to operator, `amountIn`. The
  registry settles it only against exactly that leg, so it cannot be used for anything else or
  for more. A test checks that a larger settlement is refused.
- The output is created inside the request the trader signed (`SwapRequest_Fill`), which refuses
  anything below the trader's `minOut`. This holds whatever the operator passes in.
- Orders expire at their deadline, and the trader can take the input back at any time before the
  swap settles (`SwapRequest_Cancel`). A swap the pool cannot fill is handed back and the input is
  unlocked in the same transaction.
- Nobody can place an order in someone else's name: the order desk's choices need the user's own
  signature, even though the desk is the operator's contract.

**Liquidity providers** (`Orvane/Dex/Pool.daml`)

- Funds stay in the LP's own account, locked in two committed allocations (one per asset) for a
  term between the pool's minimum and 90 days. They are never transferred to a pool contract.
- The pool checks every position on every swap: inside its term, and the allocations hold exactly
  what the books say. Reserves always equal the sum of the positions, and `x * y` never decreases.
  Rounding always favours the pool, never a trader.
- A deposit must be within the pool's ratio tolerance (1% on LocalNet) of the current price, so a
  lopsided deposit cannot move the price by more than that.
- A position can be withdrawn at any time through the operator, also while the pool is paused.
- **When the term ends, the funds come back without the operator.** The LP can withdraw a committed
  allocation with their own signature once its deadline has passed. Canton Coin goes further: Amulet
  expires the allocation at its deadline and its automation unlocks the funds without anyone acting.
  The LocalNet test token has no expiry, so there the LP takes the funds back from Portfolio.

### What you trust the operator for

The operator is the executor of every allocation in a pool. The token standard lets an executor
settle an iterated allocation with legs it chooses, so during a position's term the LP trusts the
operator to settle their allocations only through the pool contract (`PoolRules_Swap`), which moves
each position pro rata with a matching opposite leg. In particular, the operator could:

- settle an LP's allocation outside the pool contract during the term;
- delay or refuse to settle orders, or settle them in an order of its choosing (it could trade
  ahead of an order; the trader's minimum bounds what that can cost them);
- stop running, in which case orders wait until they expire and positions wait for their term end.

These are bounded. A term is at most 90 days and the funds return at its end no matter what. Every
settlement of an LP's allocation is a transaction the LP is a stakeholder of, so it is on the LP's
own node as evidence, and the asset's registry sees it too. Removing this trust is on the roadmap:
a second executor that must co-sign each settlement, or settlement only through the pool contract.

### What each party can see

| | You | Other traders | Other LPs | Operator | Registry of the asset | Public |
|---|---|---|---|---|---|---|
| That you traded, and how much | yes | no | no | yes | transfers of its own asset | no |
| Your liquidity position | yes | no | no | yes | allocations of its own asset | no |
| Who was on the other side | no | no | no | yes | of its own asset | no |
| Pool reserves and recent prices | yes | yes | yes | yes | yes | yes |

Every leg of a swap runs through the operator, so traders and LPs never appear in each other's
allocations or transactions. The operator's public API returns pool terms, reserves and recent
fills (time, price, size) and nothing about parties or positions.

### LocalNet only

- LocalNet participants accept tokens signed with the well-known secret `unsafe`. The scripts use it;
  never use them, or that secret, against a real network.
- The official Splice test token has no registry server, so on LocalNet the operator serves its
  registry API from the token admin's ledger view. On real networks each asset's issuer runs its
  own registry, and Canton Coin's is Scan.
- `scripts/fund-localnet.ps1` hands out test funds. It does not exist on real networks.

### Known limits

- At most 20 positions per pool: every swap settles every position, and registries only promise
  batches of about 50 allocations.
- Positions are not transferable (there is no LP token): a position belongs to the account that
  locked the funds.
- Amounts are Daml decimals with 10 places. A swap's rounding remainder (a few ten-billionths) goes
  to the largest position.

## Reporting a vulnerability

Please report it privately through GitHub's "Report a vulnerability" on this repository's Security
tab, not in a public issue.
