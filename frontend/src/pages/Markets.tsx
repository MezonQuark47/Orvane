// Markets: every pool the swap venue runs on this network, live, and how
// Orvane sends a swap there. Read straight from the venue's public API; no
// wallet needed.

import { motion } from 'motion/react'
import { NETWORK, VENUE } from '../ledger/network.ts'
import { useMarket } from '../swap/market.tsx'
import { VaultStage } from '../three/stage.tsx'
import { Panel, Rolling, SkeletonList, TokenIcon, fmt, fmtCompact } from '../ui/bits.tsx'

const rise = (delay: number) => ({
  initial: { y: '110%' },
  animate: { y: 0 },
  transition: { duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] as const },
})

export default function Markets() {
  const market = useMarket()
  const pools = [...market.pools].sort((x, y) => Number(y.tvlCc) - Number(x.tvlCc))
  const depth = pools.reduce((s, p) => s + Number(p.tvlCc), 0)
  const ref = NETWORK.cantex ? market.prices[NETWORK.cantex.referenceMarket]?.price : undefined
  const loading = market.status === 'loading'

  return (
    <div className="page page-markets">
      <div className="narrative">
        <VaultStage scene="trade" />
        <p className="eyebrow">Markets · {NETWORK.label}</p>
        <h1 className="display">
          <motion.span className="line" {...rise(0)}>
            Every pool,
          </motion.span>
          <motion.span className="line accent" {...rise(0.08)}>
            <em>live.</em>
          </motion.span>
        </h1>
        <p className="lede">
          {VENUE
            ? `Swaps on Orvane fill at ${VENUE}. These are its pools right now, refreshed every 15 seconds. Nothing here needs a wallet.`
            : 'This network runs the Orvane pool; its reserves are on the Liquidity page.'}
        </p>
        <dl className="stats">
          <div>
            <dt>Pools</dt>
            <dd className="mono">{loading ? '…' : pools.length}</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd className="mono">{loading ? '…' : <><Rolling value={depth} digits={0} /> CC</>}</dd>
          </div>
          {ref !== undefined && (
            <div>
              <dt>Canton Coin</dt>
              <dd className="mono">{fmt(ref, 4)} USD</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <header className="card-head">
            <h3>Pools</h3>
            <span className="muted small">deepest first</span>
          </header>
          {loading ? (
            <SkeletonList rows={4} />
          ) : pools.length === 0 ? (
            <p className="muted">{VENUE ? `${VENUE} lists no pools on ${NETWORK.label} right now.` : 'No venue pools on this network.'}</p>
          ) : (
            <ul className="market-list">
              {pools.map((p) => (
                <li key={p.poolId}>
                  <span className="market-pair">
                    <span className="market-icons" aria-hidden>
                      <TokenIcon symbol={p.a.symbol} size={22} />
                      <TokenIcon symbol={p.b.symbol} size={22} />
                    </span>
                    <span>
                      <span className="strong">
                        {p.a.symbol} / {p.b.symbol}
                      </span>
                      <span className="muted small mono">
                        1 {p.a.symbol} = {fmt(Number(p.price), Number(p.price) < 1 ? 6 : 4)} {p.b.symbol}
                      </span>
                    </span>
                  </span>
                  <span className="market-num">
                    <span className="mono">{fmtCompact(Number(p.tvlCc))} CC</span>
                    <span className="muted small mono">fee {fmt(Number(p.feeRate) * 100, 2)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel delay={0.25}>
          <header className="card-head">
            <h3>How your swap gets there</h3>
          </header>
          <ol className="route">
            <li>
              <span className="strong">Your wallet</span>
              <span className="muted small">You sign one transfer. Orvane never holds your keys or your funds.</span>
            </li>
            <li>
              <span className="strong">{NETWORK.proxy ? 'Orvane’s proxy' : 'A plain transfer'}</span>
              <span className="muted small">
                {NETWORK.proxy
                  ? 'The transfer runs inside a contract Orvane co-signs. It cannot change the amount or the receiver.'
                  : `Orvane’s proxy is not published on ${NETWORK.label} yet, so the transfer goes straight to the venue.`}
              </span>
            </li>
            <li>
              <span className="strong">{VENUE ?? 'The Orvane pool'}</span>
              <span className="muted small">Fills the swap and sends the output back to your wallet.</span>
            </li>
          </ol>
        </Panel>
      </div>
    </div>
  )
}
