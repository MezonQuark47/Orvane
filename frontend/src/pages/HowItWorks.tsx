// How it works: what Orvane does with a swap, what it can and cannot do,
// what it keeps, and how it is paid. Written for users and for anyone
// reviewing the app.

import { motion } from 'motion/react'
import { CONFIRM_IMPACT_BPS, MAX_IMPACT_BPS } from '../../../shared/quote.ts'
import { NETWORK, VENUE } from '../ledger/network.ts'
import { VaultStage } from '../three/stage.tsx'
import { Panel } from '../ui/bits.tsx'

const REPO = 'https://github.com/mezonquark47/orvane'
const pct = (bps: number) => `${bps / 100}%`

const rise = (delay: number) => ({
  initial: { y: '110%' },
  animate: { y: 0 },
  transition: { duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] as const },
})

export default function HowItWorks() {
  const venue = VENUE ?? 'the Orvane pool'
  return (
    <div className="page page-how">
      <div className="narrative">
        <VaultStage scene="how" />
        <p className="eyebrow">How it works</p>
        <h1 className="display">
          <motion.span className="line" {...rise(0)}>
            Your keys,
          </motion.span>
          <motion.span className="line accent" {...rise(0.08)}>
            <em>your call.</em>
          </motion.span>
        </h1>
        <p className="lede">
          Orvane finds the price at {venue}, checks it, and hands your wallet one transfer to sign. It never holds your tokens, and it can't move anything you
          didn't approve.
        </p>
        <ol className="route">
          <li>
            <span className="strong">1. Quote</span>
            <span className="muted small">Orvane reads {venue}’s pools and works out what you get, after fees.</span>
          </li>
          <li>
            <span className="strong">2. Check</span>
            <span className="muted small">
              A price impact above {pct(CONFIRM_IMPACT_BPS)} needs your OK; above {pct(MAX_IMPACT_BPS)} the swap is refused. You also set the least you accept.
            </span>
          </li>
          <li>
            <span className="strong">3. Sign</span>
            <span className="muted small">Your wallet shows the exact transfer. Nothing happens until you approve it there.</span>
          </li>
          <li>
            <span className="strong">4. Settle</span>
            <span className="muted small">
              {VENUE
                ? `${VENUE} fills the swap and sends the output to your wallet. Portfolio shows it until it lands.`
                : 'The pool settles both sides in one Canton transaction: all of it happens, or none of it.'}
            </span>
          </li>
        </ol>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <header className="card-head">
            <h3>What Orvane can and can’t do</h3>
          </header>
          <ul className="facts">
            <li>
              <span className="fact-yes" aria-hidden>✓</span>
              <span>Prepare a transfer for your wallet to sign, and track it until it settles.</span>
            </li>
            <li>
              <span className="fact-yes" aria-hidden>✓</span>
              <span>
                {NETWORK.proxy
                  ? 'Co-sign your transfer through its proxy contract, which runs exactly the transfer you signed and nothing else.'
                  : `Co-sign transfers through its proxy contract, once it is published on ${NETWORK.label}.`}
              </span>
            </li>
            <li>
              <span className="fact-no" aria-hidden>✕</span>
              <span>Hold your keys, hold your funds, or change the amount or the receiver of a transfer.</span>
            </li>
            <li>
              <span className="fact-no" aria-hidden>✕</span>
              <span>Move anything from your wallet without your signature.</span>
            </li>
          </ul>
        </Panel>

        <Panel delay={0.22}>
          <header className="card-head">
            <h3>What it keeps</h3>
          </header>
          <p className="muted">
            No account and no sign-up. Your swap history stays in this browser.
            {NETWORK.oneswap
              ? ' On DevNet, quotes and swaps pass through a small Orvane relay that only adds the OneSwap integrator key; it stores nothing.'
              : ''}
          </p>
        </Panel>

        <Panel delay={0.29}>
          <header className="card-head">
            <h3>How Orvane is paid</h3>
          </header>
          <p className="muted">
            There is no Orvane fee. You pay {venue}’s pool fee and the network fee your wallet charges. When Orvane’s party confirms a swap, the Canton Network
            can pay it app rewards out of the network fee (CIP-0104). Your price doesn’t change.
          </p>
        </Panel>

        <Panel delay={0.36}>
          <header className="card-head">
            <h3>Open source</h3>
          </header>
          <p className="muted">
            The app, the Daml contracts and their tests are public. Found a problem? Report it privately, as described in the repository’s security policy.
          </p>
          <p>
            <a className="link" href={REPO} target="_blank" rel="noreferrer">
              Code on GitHub
            </a>
            {' · '}
            <a className="link" href={`${REPO}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
              Security policy
            </a>
          </p>
        </Panel>
      </div>
    </div>
  )
}
