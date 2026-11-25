// The landing. One cloud of particles tells the story while you scroll:
// two tokens, one pool, two checks, and what you get back. Every number on
// the page is live, from the venue's public pools; nothing here is made up.

import { motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { toNumber } from '../../../shared/decimal.ts'
import { useDex } from '../ledger/dex.tsx'
import { NETWORK, VENUE } from '../ledger/network.ts'
import { useMarket } from '../swap/market.tsx'
import { landingStage } from '../three/stageBus.ts'
import { fmtCompact } from '../ui/bits.tsx'
import { scrollToTarget } from '../ui/smooth.ts'

type Go = (tab: 'swap' | 'liquidity') => void

const ease = [0.16, 1, 0.3, 1] as const
const REPO = 'https://github.com/mezonquark47/orvane'
const SECTIONS = ['ex-hero', 'ex-pool', 'ex-checks', 'ex-swap'] as const
const RAIL = ['01 two tokens', '02 one pool', '03 two checks', '04 your swap']

export default function Landing({ go }: { go: Go }) {
  const stage = useLandingStage()
  return (
    <div className="ex">
      <div className="ex-rail" aria-hidden>
        {RAIL.map((r, i) => (
          <div key={r} className={Math.round(stage) === i ? 'on' : ''}>
            {r}
          </div>
        ))}
      </div>
      <Hero go={go} />
      <Pool />
      <Checks />
      <SwapSection go={go} />
    </div>
  )
}

// How far the story has got: 0..3, continuous. Each section counts as it
// comes up past the middle of the screen. The particle scene reads it.
function useLandingStage() {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    landingStage.active = true
    let raf = 0
    let last = -1
    const tick = () => {
      raf = requestAnimationFrame(tick)
      let s = 0
      for (const id of SECTIONS.slice(1)) {
        const el = document.getElementById(id)
        if (!el) continue
        const top = el.getBoundingClientRect().top
        s += Math.min(1, Math.max(0, (window.innerHeight * 0.95 - top) / (window.innerHeight * 0.75)))
      }
      landingStage.value = s
      const r = Math.round(s)
      if (r !== last) {
        last = r
        setShown(r)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      landingStage.active = false
      landingStage.value = 0
    }
  }, [])
  return shown
}

// A heading that arrives letter by letter when it scrolls into view. Words
// never break across lines.
function Split({ text, light, as: Tag = 'h2', className }: { text: string; light?: string; as?: 'h1' | 'h2'; className: string }) {
  let n = 0
  const words = (t: string, weight: 'b' | 'l') =>
    t.split(' ').map((w, wi) => (
      <span key={`${weight}${wi}`}>
        <span className="ex-word">
          {[...w].map((c, ci) => (
            <motion.span
              key={ci}
              className="ex-ch"
              initial={{ y: '110%', opacity: 0, rotate: 6 }}
              whileInView={{ y: 0, opacity: 1, rotate: 0 }}
              viewport={{ once: true, amount: 0.6 }}
              transition={{ duration: 0.9, ease, delay: n++ * 0.018 }}
            >
              {c}
            </motion.span>
          ))}
        </span>{' '}
      </span>
    ))
  return (
    <Tag className={className} aria-label={light ? `${text} ${light}` : text}>
      <span aria-hidden>
        {words(text, 'b')}
        {light && <em>{words(light, 'l')}</em>}
      </span>
    </Tag>
  )
}

const Rise = ({ children, className }: { children: ReactNode; className?: string }) => (
  <motion.div className={className} initial={{ y: 40, opacity: 0 }} whileInView={{ y: 0, opacity: 1 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 1, ease }}>
    {children}
  </motion.div>
)

// ---------------------------------------------------------------- 01 hero

function Hero({ go }: { go: Go }) {
  return (
    <section id="ex-hero">
      <p className="ex-eyebrow">{VENUE ? `${NETWORK.label} · token swap` : `${NETWORK.label} · exchange`}</p>
      <Split as="h1" className="ex-h1" text="Move value without letting go of it." />
      <Rise>
        <p className="ex-lede">
          {VENUE
            ? `Swap any token ${VENUE} lists, straight from your own wallet into its pools. Orvane holds nothing and charges nothing. Move your cursor through the particles.`
            : 'Swap Canton Coin in one atomic transaction, and provide liquidity without handing it to anyone. Move your cursor through the particles.'}
        </p>
        <div className="ex-cta">
          <button className="ex-btn" onClick={() => go('swap')}>
            Start a swap
          </button>
          <button className="ex-ghost" onClick={() => scrollToTarget(document.getElementById('ex-pool')!)}>
            scroll to see how ↓
          </button>
        </div>
      </Rise>
    </section>
  )
}

// ---------------------------------------------------------------- 02 the route

function Pool() {
  const market = useMarket()
  const { config } = useDex()
  const depth = market.pools.reduce((s, p) => s + Number(p.tvlCc), 0)
  const pool = config?.pools[0]
  return (
    <section id="ex-pool" className="ex-right">
      <p className="ex-eyebrow">02 · the route</p>
      <Split className="ex-h2" text="It flows through the pool," light="not through us." />
      <Rise>
        <p className="ex-lede">
          {VENUE ? (
            <>
              Your <span className="ex-cc">tokens</span> go from your wallet into {VENUE}'s pool and the <span className="ex-usd">output</span> comes straight back.
              Orvane only builds the transfer and shows you the math.
            </>
          ) : (
            'Your trade settles against every provider at once, in one transaction. Liquidity stays in its owner’s account and comes back on its own at the end of its term.'
          )}
        </p>
        <div className="ex-stats">
          <div>
            <b>0%</b>
            <span>Orvane fee</span>
          </div>
          {VENUE ? (
            <>
              <div>
                <b>{market.tokens.length || '—'}</b>
                <span>tokens on {VENUE}</span>
              </div>
              <div>
                <b>{depth ? fmtCompact(depth) : '—'}</b>
                <span>CC in its pools</span>
              </div>
            </>
          ) : (
            <div>
              <b>{pool ? `${(pool.feeBps / 100).toFixed(2)}%` : '—'}</b>
              <span>pool fee, to providers</span>
            </div>
          )}
        </div>
      </Rise>
    </section>
  )
}

// ---------------------------------------------------------------- 03 the checks

function Checks() {
  return (
    <section id="ex-checks">
      <p className="ex-eyebrow">03 · the checks</p>
      <Split className="ex-h2" text="Checked by the math," light="then checked again." />
      <Rise>
        <div className="ex-pair">
          <div>
            <div className="n">check 01</div>
            <h3>Priced from the reserves</h3>
            <p>
              Orvane works out the output from the pools' own reserves and holds it against {VENUE ? `${VENUE}'s` : 'the pool’s'} quote. If they disagree, you see it before
              anything is signed.
            </p>
          </div>
          <div>
            <div className="n">check 02</div>
            <h3>Re-quoted before you sign</h3>
            <p>Right before your wallet opens, the quote is taken again. If it moved past your limit, nothing is sent.</p>
          </div>
        </div>
        <ul className="ex-list">
          <li>
            <span>Price impact</span>
            <span>your OK above 5%</span>
          </li>
          <li>
            <span>Pool price vs. market price</span>
            <span>flagged if far off</span>
          </li>
          <li>
            <span>Can your wallet receive it</span>
            <span>checked</span>
          </li>
          <li>
            <span>Who signs</span>
            <span>only your wallet</span>
          </li>
        </ul>
      </Rise>
    </section>
  )
}

// ---------------------------------------------------------------- 04 your swap

// What one Canton Coin fetches right now, from the venue's live pools.
function RouteCard({ go }: { go: Go }) {
  const market = useMarket()
  const cc = market.cc
  const pool = cc ? market.pools.find((p) => p.a.id === cc.id || p.b.id === cc.id) : undefined
  const other = pool && cc ? (pool.a.id === cc.id ? pool.b : pool.a) : undefined
  const price = pool && cc ? (pool.a.id === cc.id ? Number(pool.reserveB) / Number(pool.reserveA) : Number(pool.reserveA) / Number(pool.reserveB)) : undefined
  return (
    <div className="ex-card">
      <div className="h">
        <b>Swap</b>
        <span>● live · {NETWORK.label}</span>
      </div>
      <div className="ex-field">
        <div className="l">You send</div>
        <div className="m">
          1
          <span className="ex-tok">
            <i style={{ background: 'var(--cc)' }} />
            CC
          </span>
        </div>
      </div>
      <div className="ex-field">
        <div className="l">You receive, at the pool price now</div>
        <div className="m">
          {price === undefined ? '—' : price.toLocaleString('en-US', { maximumSignificantDigits: 6 })}
          <span className="ex-tok">
            <i style={{ background: 'var(--usd)' }} />
            {other?.symbol ?? '—'}
          </span>
        </div>
      </div>
      <div className="ex-meta">
        <div>
          <span>Venue</span>
          <span>{VENUE ?? 'Orvane pool'}</span>
        </div>
        <div>
          <span>Orvane fee</span>
          <span>0</span>
        </div>
        <div>
          <span>Orvane check</span>
          <b>before every signature</b>
        </div>
      </div>
      <button className="ex-btn" onClick={() => go('swap')}>
        Open the swap
      </button>
    </div>
  )
}

function SwapSection({ go }: { go: Go }) {
  return (
    <section id="ex-swap" className="ex-swap">
      <Rise>{VENUE ? <RouteCard go={go} /> : <PoolCard go={go} />}</Rise>
      <div className="ex-side">
        <Split className="ex-h2" text="Press swap." light="Watch it turn." />
        <p>
          every particle is a unit you send ·{' '}
          <a className="ex-ghost" href={REPO} target="_blank" rel="noreferrer">
            read the code ↗
          </a>
        </p>
      </div>
    </section>
  )
}

// LocalNet: the Orvane pool's own price, from its reserves.
function PoolCard({ go }: { go: Go }) {
  const { config, pools, instrument } = useDex()
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined
  const a = pool ? instrument(pool.instrumentA).label : ''
  const b = pool ? instrument(pool.instrumentB).label : ''
  const price = live && live.reserveA > 0n ? toNumber(live.reserveB) / toNumber(live.reserveA) : undefined
  return (
    <div className="ex-card">
      <div className="h">
        <b>Swap</b>
        <span>● {NETWORK.label}</span>
      </div>
      <div className="ex-field">
        <div className="l">You send</div>
        <div className="m">
          1 <span className="ex-tok">{a}</span>
        </div>
      </div>
      <div className="ex-field">
        <div className="l">You receive, at the pool price now</div>
        <div className="m">
          {price === undefined ? '—' : price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} <span className="ex-tok">{b}</span>
        </div>
      </div>
      <button className="ex-btn" style={{ marginTop: 18 }} onClick={() => go('swap')}>
        Open the exchange
      </button>
    </div>
  )
}
