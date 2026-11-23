// The landing: one long camera move through the vault. Each chapter reserves
// a stage and the vault flies from one to the next as you scroll, changing its
// pose on the way: hero, swap, liquidity, and back.

import { motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { toNumber } from '../../../shared/decimal.ts'
import { useDex } from '../ledger/dex.tsx'
import { NETWORK, VENUE } from '../ledger/network.ts'
import { useMarket } from '../swap/market.tsx'
import { VaultStage, type StageScene } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { fmtCompact } from '../ui/bits.tsx'

type Go = (tab: 'swap' | 'liquidity') => void

const ease = [0.22, 1, 0.36, 1] as const
const REPO = 'https://github.com/mezonquark47/orvane'

export default function Landing({ go }: { go: Go }) {
  return (
    <div className="landing">
      <Hero go={go} />
      {(VENUE ? SWAP_CHAPTERS : CHAPTERS).map((c, i) => (
        <Chapter key={c.id} chapter={c} flip={i % 2 === 1} go={go} />
      ))}
      <Finale go={go} />
    </div>
  )
}

// ---------------------------------------------------------------- hero

const HEADLINE = VENUE
  ? [
      ['Swap', 'on', 'Canton,'],
      ['checked', 'twice.'],
    ]
  : [
      ['Liquidity', 'that', 'never'],
      ['leaves', 'your', 'wallet.'],
    ]

function Hero({ go }: { go: Go }) {
  // one settle-pulse once the headline has landed, so the vault says hello
  useEffect(() => {
    const t = setTimeout(() => signalSettled(), 1700)
    return () => clearTimeout(t)
  }, [])

  let w = 0
  return (
    <section className="ln-hero">
      <VaultStage scene="hero" className="ln-hero-stage" />
      <motion.p className="ln-kicker" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease, delay: 0.2 }}>
        <span className="ln-pip" /> {VENUE ? 'Swaps on the Canton Network, from your own wallet' : 'The exchange on the Canton Network'}
      </motion.p>
      <h1 className="ln-mega">
        {HEADLINE.map((line, li) => (
          <span key={li} className={`ln-line ${li === 1 ? 'ln-it' : ''}`}>
            {line.map((word) => (
              <motion.span
                key={word}
                className="ln-word"
                initial={{ opacity: 0, y: '0.5em', filter: 'blur(14px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ duration: 1.1, ease, delay: 0.35 + w++ * 0.09 }}
              >
                {word}
              </motion.span>
            ))}
          </span>
        ))}
      </h1>
      <motion.div className="ln-hero-foot" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1, ease, delay: 1.1 }}>
        <p className="ln-lede">
          {VENUE
            ? `Any token ${VENUE} lists, straight from your wallet into its pools. Orvane prices every swap itself and checks it again just before your wallet opens. No account, no fee.${NETWORK.proxy ? '' : ' Nothing kept.'}`
            : 'Swap Canton Coin in one atomic transaction. Provide liquidity without handing it to anyone: it stays in your account, and comes back on its own at the end of its term.'}
        </p>
        <div className="ln-ctas">
          <button className="ln-btn" onClick={() => go('swap')}>
            Enter the vault <Arrow />
          </button>
          <a className="ln-ghost" href={REPO} target="_blank" rel="noreferrer">
            Read the code ↗
          </a>
        </div>
      </motion.div>
      <Ticker />
    </section>
  )
}

// What the pool is doing right now, from the operator's public API. More
// fills than last time means something settled, and the vault pulses.
function usePoolPulse() {
  const { config, pools } = useDex()
  const live = config ? pools.get(config.pools[0]?.poolId ?? '') : undefined
  const swaps = live?.swaps
  useEffect(() => {
    if (swaps) signalSettled()
  }, [swaps])
  return live
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function Ticker() {
  return VENUE ? <MarketTicker /> : <PoolTicker />
}

// The venue's market, live: what Orvane swaps against.
function MarketTicker() {
  const market = useMarket()
  const ref = NETWORK.cantex ? market.prices[NETWORK.cantex.referenceMarket] : undefined
  const depth = market.pools.reduce((s, p) => s + Number(p.tvlCc), 0)
  return (
    <motion.div className="ln-ticker" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 1.5 }}>
      <Stat k="Network" v={NETWORK.label} live={market.status === 'ready'} />
      <Stat k="Tokens" v={market.tokens.length ? String(market.tokens.length) : '—'} />
      <Stat k="Pool depth" v={depth ? `${fmtCompact(depth)} CC` : '—'} />
      <Stat k="Canton Coin" v={ref ? `${ref.price.toLocaleString('en-US', { maximumSignificantDigits: 4 })} USDC` : '—'} />
      <Stat k="Orvane fee" v="0" accent />
    </motion.div>
  )
}

function PoolTicker() {
  const { status, config, instrument } = useDex()
  const live = usePoolPulse()
  const pool = config?.pools[0]
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const last = live?.recent.at(-1)?.at
  const network = status === 'offline' ? 'Offline' : config?.network === 'localnet' ? 'Canton LocalNet' : status === 'ready' ? (config?.network ?? '') : 'Connecting'
  return (
    <motion.div className="ln-ticker" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 1.5 }}>
      <Stat k="Ledger" v={network} live={status === 'ready'} />
      <Stat k="Swaps settled" v={live ? live.swaps.toLocaleString('en-US') : '—'} />
      <Stat k="Last swap" v={last ? ago(now - last) : '—'} />
      <Stat
        k="Pool depth"
        v={
          live && pool
            ? `${fmtCompact(toNumber(live.reserveA))} ${instrument(pool.instrumentA).label} · ${fmtCompact(toNumber(live.reserveB))} ${instrument(pool.instrumentB).label}`
            : '—'
        }
      />
      <Stat k="Funds held by Orvane" v="0" accent />
    </motion.div>
  )
}

const Stat = ({ k, v, live, accent }: { k: string; v: string; live?: boolean; accent?: boolean }) => (
  <div className="ln-stat">
    <span className="ln-k">
      {live && <span className="ln-live" />}
      {k}
    </span>
    <span className={`ln-v ${accent ? 'accent' : ''}`}>{v}</span>
  </div>
)

// ---------------------------------------------------------------- chapters

interface ChapterData {
  id: string
  n: string
  scene: StageScene
  tab: 'swap' | 'liquidity'
  open: string
  kicker: string
  title: ReactNode
  body: string
  Card: () => ReactNode
  lift?: number
}

const Seal = ({ children }: { children: ReactNode }) => <span className="ln-seal">{children}</span>

// What one unit of the pool's first asset fetches right now. Live, from the
// pool's public reserves; nothing on this page is made up.
function SwapCard() {
  const { config, pools, instrument } = useDex()
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined
  const a = pool ? instrument(pool.instrumentA).label : ''
  const b = pool ? instrument(pool.instrumentB).label : ''
  const price = live && live.reserveA > 0n ? toNumber(live.reserveB) / toNumber(live.reserveA) : undefined
  return (
    <div className="ln-card">
      <div className="ln-card-head">
        <span>Your receipt</span>
        <Seal>settles at once</Seal>
      </div>
      <div className="ln-big">
        1 <small>{a}</small>
      </div>
      <div className="ln-arrow" />
      <div className="ln-big brass">
        {price === undefined ? '—' : price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} <small>{b}</small>
      </div>
      <div className="ln-row">
        <span>pool price now · fee {pool ? (pool.feeBps / 100).toFixed(2) : '—'}%</span>
        <span>1 transaction</span>
      </div>
    </div>
  )
}

// The pool's real terms: how long a deposit can be locked, and when one
// made today would come back on its own.
function LiquidityCard() {
  const { config } = useDex()
  const pool = config?.pools[0]
  const until = pool ? new Date(Date.now() + Math.min(30 * 86_400, pool.maxTermSeconds) * 1000) : undefined
  return (
    <div className="ln-card">
      <div className="ln-card-head">
        <span>Your position</span>
        <Seal>earns fees</Seal>
      </div>
      <div className="ln-row">
        <span>held in</span>
        <span className="verd">your own account</span>
      </div>
      <div className="ln-row">
        <span>withdraw</span>
        <span>any time</span>
      </div>
      <div className="ln-row">
        <span>unlocks by itself</span>
        <span>{until ? until.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'}</span>
      </div>
      <div className="ln-row">
        <span>earns</span>
        <span>{pool ? `${(pool.feeBps / 100).toFixed(2)}% of every trade` : '—'}</span>
      </div>
    </div>
  )
}

// What a swap of Canton Coin gets right now, from the venue's live pools.
function RouteCard() {
  const market = useMarket()
  const cc = market.cc
  const pool = cc ? market.pools.find((p) => p.a.id === cc.id || p.b.id === cc.id) : undefined
  const other = pool && cc ? (pool.a.id === cc.id ? pool.b : pool.a) : undefined
  const price = pool && cc ? (pool.a.id === cc.id ? Number(pool.reserveB) / Number(pool.reserveA) : Number(pool.reserveA) / Number(pool.reserveB)) : undefined
  return (
    <div className="ln-card">
      <div className="ln-card-head">
        <span>From your wallet</span>
        <Seal>straight to the pool</Seal>
      </div>
      <div className="ln-big">
        1 <small>CC</small>
      </div>
      <div className="ln-arrow" />
      <div className="ln-big brass">
        {price === undefined ? '—' : price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} <small>{other?.symbol ?? ''}</small>
      </div>
      <div className="ln-row">
        <span>{market.tokens.length} tokens · {market.pools.length} pools</span>
        <span>Orvane fee 0</span>
      </div>
    </div>
  )
}

// The checks every swap goes through before the wallet is asked to sign.
function ChecksCard() {
  return (
    <div className="ln-card">
      <div className="ln-card-head">
        <span>Before you sign</span>
        <Seal>every swap</Seal>
      </div>
      <div className="ln-row">
        <span>Orvane's own pricing</span>
        <span className="verd">matches the pools</span>
      </div>
      <div className="ln-row">
        <span>Fresh quote vs. the one you saw</span>
        <span>within your limit</span>
      </div>
      <div className="ln-row">
        <span>Price impact</span>
        <span>your OK above 5%</span>
      </div>
      <div className="ln-row">
        <span>Pool price vs. market price</span>
        <span>flagged if far off</span>
      </div>
      <div className="ln-row">
        <span>Can your wallet receive it</span>
        <span>checked</span>
      </div>
    </div>
  )
}

const SWAP_CHAPTERS: ChapterData[] = [
  {
    id: 'swap',
    n: 'I',
    scene: 'trade',
    tab: 'swap',
    open: 'Start swapping',
    kicker: 'Swap',
    title: (
      <>
        Your wallet,
        <br />
        <em>Canton's deepest pools.</em>
      </>
    ),
    body: `Pick any token ${VENUE} lists and swap it from the wallet you already use. Your wallet sends it straight to ${VENUE}'s pools and the output comes straight back. Orvane never holds anything and charges nothing.`,
    Card: RouteCard,
  },
  {
    id: 'checks',
    n: 'II',
    scene: 'liquidity',
    tab: 'swap',
    open: 'See a quote',
    lift: 0.35,
    kicker: 'Checked twice',
    title: (
      <>
        A price you can trust,
        <br />
        <em>checked before you sign.</em>
      </>
    ),
    body: "Cantex fills a swap at the pool price when it arrives. So Orvane prices every swap itself from the pools, compares it with Cantex's quote, and quotes again just before your wallet opens. If the price moved past your limit, nothing is sent. Every transfer expires after 15 minutes, so it cannot be filled later at a price nobody checked.",
    Card: ChecksCard,
  },
]

const CHAPTERS: ChapterData[] = [
  {
    id: 'swap',
    n: 'I',
    scene: 'trade',
    tab: 'swap',
    open: 'Open the exchange',
    kicker: 'Swap',
    title: (
      <>
        One pool, every provider,
        <br />
        <em>one transaction.</em>
      </>
    ),
    body: 'Sell an exact amount for at least the minimum you set, in one atomic transaction. Your trade settles against every provider at once through the operator.',
    Card: SwapCard,
  },
  {
    id: 'liquidity',
    n: 'II',
    scene: 'liquidity',
    tab: 'liquidity',
    open: 'Provide liquidity',
    lift: 0.35,
    kicker: 'Liquidity',
    title: (
      <>
        Earn on every trade.
        <br />
        <em>Keep the keys.</em>
      </>
    ),
    body: 'Your deposit is locked in your own account for a term you pick, never moved to a pool contract. Withdraw whenever you like. If Orvane disappears, the token standard unlocks your funds on their own when the term ends.',
    Card: LiquidityCard,
  },
]

function Chapter({ chapter: c, flip, go }: { chapter: ChapterData; flip: boolean; go: Go }) {
  return (
    <section className={`ln-chapter ${flip ? 'ln-flip' : ''}`}>
      <div className="ln-stage-col">
        <VaultStage scene={c.scene} lift={c.lift} className="ln-chapter-stage" />
      </div>
      <motion.div
        className="ln-copy"
        initial={{ opacity: 0, y: 40, filter: 'blur(8px)' }}
        whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        viewport={{ amount: 0.45, once: true }}
        transition={{ duration: 1, ease }}
      >
        <span className="ln-numeral" aria-hidden>
          {c.n}
        </span>
        <p className="ln-kicker">
          <span className="ln-pip" /> {c.kicker}
        </p>
        <h2 className="ln-title">{c.title}</h2>
        <p className="ln-body">{c.body}</p>
        <c.Card />
        <button className="ln-ghost ln-open" onClick={() => go(c.tab)}>
          {c.open} <Arrow />
        </button>
      </motion.div>
    </section>
  )
}

// ---------------------------------------------------------------- finale

function Finale({ go }: { go: Go }) {
  return (
    <section className="ln-finale">
      <VaultStage scene="hero" className="ln-finale-stage" />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ amount: 0.5, once: true }}
        transition={{ duration: 1.2, ease }}
      >
        <h2 className="ln-mega small">
          The vault is <em>open.</em>
        </h2>
        <div className="ln-ctas">
          <button className="ln-btn" onClick={() => go('swap')}>
            Enter the vault <Arrow />
          </button>
          <a className="ln-ghost" href={REPO} target="_blank" rel="noreferrer">
            {VENUE ? 'Read the code ↗' : 'Read the Daml ↗'}
          </a>
        </div>
      </motion.div>
    </section>
  )
}

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
    <path d="M2 7h9M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
