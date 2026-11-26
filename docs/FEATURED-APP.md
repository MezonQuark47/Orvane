# Orvane as a Featured App

What the Canton Foundation asks of a Featured App, where Orvane stands, and the plan to get there.
Source: the Foundation's *Featured App Qualification and Guidance* (v2.0b, approved 2026-10-22) and
the CIP-0116 locking FAQ, both on intro.canton.foundation. Re-read them before applying: thresholds
change with public notice.

Order of work: **DevNet first, then MainNet.** Featured status exists on MainNet only. DevNet is where
we test the proxy and the reward mechanics (DevNet rules let a party feature itself, see
`scripts/proxy-setup.ts`).

## 1. What Orvane is, for the application

A swap front end for Canton. Users swap from their own wallet (Loop or any CIP-0103 wallet); the swap
fills at a venue (Cantex on TestNet and MainNet, OneSwap on DevNet). Every swap is one token-standard
transfer that runs inside Orvane's `WalletUserProxy` (splice-util-featured-app-proxies), so Orvane's
featured party confirms it. Orvane charges no fee; it is paid through app rewards (CIP-0104,
traffic-based: about 1.0 reward weight per $1 of traffic burned).

Orvane also has its own self-custodial pool (`daml/orvane`). It runs on LocalNet only and is **not**
the MainNet liquidity source. MainNet liquidity comes from the venue.

## 2. Parties (C1)

The guidance wants the rewarded party used for nothing else, a separate party that runs operations,
and a separate party that holds the Canton Coin lock.

| Role | Party hint | Where it is set | Used for |
|---|---|---|---|
| Featured app party | `orvane-app` | `FEATURED_APP_HINT`, `operator/network.ts` | Signs the proxy; named in the application and in the on-chain vote. Nothing else. |
| Operations | `orvane-operator` | `operatorHint` in `config/pairs.<network>.json` | The Orvane pool (LocalNet). Never the featured party. |
| Locking party | set by the lock provider | `lockingHint` (optional) | Holds the 5,000,000 CC lock. Disclosed to the Foundation. |

`scripts/proxy-setup.ts` and the operator refuse a config that gives two roles the same party.

Create the featured party once, on the validator we keep. A party id change after approval goes
through the Foundation's party-id change process.

## 3. Basic Featured App: the plan

| Requirement | Status | Next step |
|---|---|---|
| 5,000,000 CC locked per featured party (CIP-0116) | Planned: rented from Cashen, paid from monthly revenue | Agree the term with Cashen. Get the locking party id. Confirm Cashen can lock for 60+ days (unlocking takes 60 days, 1/60 per day). |
| Locking party kept apart from normal activity and from any SV lock | Not started | Cashen's locking party is used for this lock only. |
| Application form (canton.foundation/featured-app-request) | Not started | Fill it in once the items below are done. Mention that we are "ready to lock". Ready-to-lock apps may be reviewed first. |
| Separate featured and operations parties | Done in code (section 2) | Allocate both on the MainNet validator. |
| Validator with the proxy package | DevNet: through 5N Seaport, no API access yet | Get a validator (or NaaS) that gives us ledger API access. Run `scripts/proxy-setup.ts`. |
| Proxy package on users' validators | Waiting on Five North (Loop) | Ask Five North to load `splice-util-featured-app-proxies` 1.2.5. |
| Live on MainNet with a first real swap | Not started | DEPLOY.md, section 3. |

**Economics check before signing with Cashen.** Rewards come only from traffic that Orvane's swaps
burn. The rental has to be paid whether or not anyone swaps. Write down the break-even swap count:

```
monthly rental cost (USD)  <=  swaps per month x traffic burned per swap (USD) x reward per $1 burned
```

Take the reward per $1 burned from the current round data (dashboard.canton.foundation). The cap is
$1.50 today and may drop to $0.79. Measure the traffic per swap on DevNet. Do not sign before the
numbers work at a cautious volume.

## 4. Asset-Moving Featured App: the later step

A swap app moves assets, so it will be asked for this tier after Basic status. Requirements and our
position:

| Requirement | Orvane |
|---|---|
| Basic status, in good standing | First (section 3). |
| About 3 integrations with featured wallets, venues or assets | Targets: Loop (wallet), Cantex (venue), Canton Coin and USDCx (assets). CBTC on DevNet. |
| CIP-0056 / CIP-0112 for assets, CIP-0103 for wallets | CIP-0056 V1 transfers today; CIP-0103 wallets done. The pool uses CIP-0112 (V2). |
| Pre-approvals and UTXO auto-merge | Pre-approval is handled (`Swap.tsx` warns when it is missing). Auto-merge is the wallet's job; check Loop's behaviour. |
| Net-positive fees per user; no users paying more for activity than they get | No Orvane fee. Check that the proxy adds no traffic cost for the user. |
| Segregated operator parties, for monitoring | Section 2. |
| Co-validation by 2+ independent validators; recovery if a node is lost | Not started. Needs the MainNet validator plan. |
| Full security audit, report shared with the Tokenomics Committee | Not started. Scope and threat model: `docs/THREAT-MODEL.md`. |
| Open access: no gated sign-up | Done: no account, no sign-up. |

## 5. Rules to keep after approval

- Rewards come from real user activity only. Wash trading, bots, incentivised or collusive volume,
  needless UTXO merges, or splitting and batching transactions to farm rewards lead to a pause.
- Under the pre-CIP-0104 marker rules: markers within two reward rounds of the burn, a 1:1
  marker-to-burn target, and a pause above a 15% overage (24 hours) or 3% (30 days). Orvane creates
  no markers (`optFeaturedAppRightCid: null` in `shared/proxy.ts`), so this applies only if that
  changes.
- Sudden changes trigger a review: more than 100% activity change day over day, or more than 5%
  daily pool impact.
- Operational limits: merges aim for 10 UTXOs (4 or fewer per party on average). Drip campaigns
  stay under 0.125 TPS. Billing runs at most once per customer every 12 hours.
