# Deploying Orvane

Two separate pieces: the website, which is all a swap needs, and Orvane's validator with its transfer
proxy, which is what earns featured-app rewards.

## 1. The website (Vercel)

On TestNet and MainNet the app is a static site. It talks to Cantex's public API and to the user's
wallet; there is no Orvane server. `vercel.json` holds the build and the security headers.

1. In Vercel: **Add New → Project**, import the repository. Leave **Root Directory** at the repository
   root; `vercel.json` sets the rest (install `npm ci --prefix frontend`, build
   `npm --prefix frontend run build:mainnet`, output `frontend/dist`).
2. **Settings → Build and Deployment → Node.js Version**: 22.x.
3. Deploy. Every push to `main` deploys to production; other branches get their own preview address.
4. Once the site has its own domain, set the environment variable `VITE_SITE_URL` to it (for example
   `https://orvane.xyz`). Until then link previews use Vercel's production address.

What the headers in `vercel.json` do:

- `Content-Security-Policy`: scripts only from the site itself. Network connections only to the site,
  Cantex (`api.cantex.io`, `api.testnet.cantex.io`) and Loop's connection service (`cantonloop.com`,
  `testnet.cantonloop.com`). No other site may frame it. Inline styles are allowed because Loop's
  sign-in window adds its own stylesheet. A new wallet or data source needs its address added here.
- `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy` (no camera, microphone, location, payment or USB access).
- No `Cross-Origin-Opener-Policy`: Loop signs in through a popup and watches whether it is still open,
  which that header would break.
- Hashed files under `/assets/` are cached for a year.

### Cloudflare Pages (the DevNet site at orvane.work)

The same site also runs on Cloudflare Pages, with no Vercel files involved: the security headers are
in `frontend/public/_headers` (Cloudflare's format, the same values as `vercel.json`; change both
together), and `/api/oneswap` is `functions/api/oneswap.ts`. Both hosts share the forwarding code in
`shared/oneswap-forward.ts`.

1. Cloudflare: **Add a domain** → `orvane.work` (Free plan). At the registrar (Namecheap: Domain →
   Nameservers → Custom DNS) replace the nameservers with the two Cloudflare gives, and wait until
   Cloudflare shows the domain as active.
2. **Workers & Pages → Create → Pages → Connect to Git**, pick the repository, then:
   - Production branch: `main`
   - Framework preset: None; Root directory: empty (the repository root, where `functions/` is)
   - Build command: `npm ci --prefix frontend && npm --prefix frontend run build:devnet`
   - Build output directory: `frontend/dist`
3. **Variables and secrets** (Production): `NODE_VERSION` = `22`, `VITE_ORVANE_NETWORK` = `devnet`,
   `VITE_SITE_URL` = `https://orvane.work`, and `ONESWAP_API_KEY` as a **Secret**. Variables only
   reach a build started after they were set, so deploy again after adding them.
4. The project's **Custom domains** → add `orvane.work` and `www.orvane.work`; Cloudflare writes the
   DNS records itself.
5. On OneSwap, allow `https://orvane.work` (and `https://www.orvane.work`) on the integrator key.
6. Keep Cloudflare's script injection off for this site (Rocket Loader, Email Address Obfuscation,
   Web Analytics' automatic setup): the CSP allows scripts from the site only, so injected scripts
   are blocked.

Locally, `npx wrangler pages dev frontend/dist --binding ONESWAP_API_KEY=<key>` serves a built site
with the headers and the function, as Cloudflare will.

### The DevNet site (OneSwap)

Cantex has no DevNet, so on DevNet swaps go through [OneSwap](https://docs.oneswap.cc) instead,
for testing; MainNet and TestNet keep Cantex. OneSwap opens every swap with an integrator key that
must not reach the browser, so the app calls `/api/oneswap`, a Vercel function (`api/oneswap.ts`)
that adds the key and passes on only the calls the app makes, to OneSwap's DevNet API only.

1. Create a DevNet integrator key at [devnet.oneswap.cc](https://devnet.oneswap.cc).
2. In Vercel, a second project from the same repository, with two environment variables:
   `VITE_ORVANE_NETWORK` = `devnet` and `ONESWAP_API_KEY` = the key. The MainNet project has no key,
   so its `/api/oneswap` answers that OneSwap is not set up.
3. A [Loop](https://wallet.devnet.looptech.io) DevNet wallet with DevNet Canton Coin.

Locally: put `ONESWAP_API_KEY=...` in `frontend/.env.local` (ignored by git) and run
`npm run dev:devnet`; the development server adds the key the same way.

What differs from Cantex: OneSwap answers with a deposit party per swap and the wallet sends the
input there without a memo; it holds the swap to the user's minimum output, refunds a swap it cannot
fill, and reports each swap's state, which the app follows. It takes a network fee from the input.
OneSwap's DevNet has one pool with liquidity (CC/CBTC). The site's `/api/oneswap` is open to
anyone who reaches it and spends Orvane's key; fine for DevNet, not for MainNet.

## 2. Orvane's validator and proxy

Swaps work without this; it is what makes Orvane's party a confirmer of every swap (see the README,
"Orvane's proxy and featured-app rewards").

1. **A validator** on the network (self-hosted or a node-as-a-service provider), with a ledger user that
   logs in through OAuth 2.0 client credentials (Auth0, Keycloak, ...) and may allocate parties and
   grant itself rights on them (participant admin). Ask the provider for these if they run the node.
2. **The config.** Copy `config/pairs.example.json` to `config/pairs.<network>.json` (`devnet`,
   `testnet` or `mainnet`) and fill it in:
   - `ledger.url`: the validator's JSON Ledger API.
   - `ledger.adminUser`, `ledger.appUser`: the ledger user the client logs in as, which is the subject
     of its tokens (on Auth0, `<client id>@clients`).
   - `ledger.audience`: the audience the participant checks (Splice's default is
     `https://canton.network.global`).
   - `ledger.oidc.tokenUrl`, plus `scope` if the identity provider needs one.
   - `userParticipants`: other participants you run that host users; usually none.
   - `scan`: DevNet only, a Scan your machine can reach, to feature the party. Scans accept known IP
     addresses only, so run the script from the validator's network if yours is not allowed.
3. **Run the setup** with the client's credentials in the environment, never in a file:

   ```powershell
   $env:ORVANE_NETWORK = 'devnet'
   $env:ORVANE_OIDC_CLIENT_ID = '<client id>'
   $env:ORVANE_OIDC_CLIENT_SECRET = '<client secret>'
   node scripts/proxy-setup.ts
   ```

   It loads the proxy package (or says to ask the validator's operator, if the node does not take
   uploads), allocates the `orvane-app` party, features it on DevNet, creates the proxy and writes
   `frontend/public/orvane-proxy.<network>.json`. Running it again changes nothing.
4. **Switch the app over**: set `proxy: '/orvane-proxy.<network>.json'` for that network in
   `shared/networks.ts`, commit both files and push.
5. **The users' side**: a Loop user's swap runs through the proxy only once Five North has loaded
   `splice-util-featured-app-proxies` 1.2.5 on Loop's validators. Until then the app sends plain
   transfers, before anything is signed.

The `orvane-app::…` party is the one to name in the Featured App application and the Canton Coin
lock. Create it once, on the validator you will keep.

## 3. Before applying as a Featured App

| Step | Who |
|---|---|
| A company: name, website and background for the application | you |
| A validator, the `orvane-app` party and the proxy (section 2) | you and the validator provider |
| The proxy package on Loop's validators | Five North |
| A first small MainNet swap (at least 50 CC) through the site | you |
| The site live on MainNet; the form asks how long it has been live | you |
| 5,000,000 CC locked for the `orvane-app` party (CIP-0116), from a separate locking party | you and the lock provider |
| A security audit, before the asset-moving tier | you and the auditor |

The full requirements, the party roles and the plan are in [docs/FEATURED-APP.md](docs/FEATURED-APP.md).
The audit scope is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).
