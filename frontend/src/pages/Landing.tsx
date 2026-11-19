// The landing: one long camera move through the vault. Each chapter reserves
// a stage and the vault flies from one to the next as you scroll, changing its
// pose on the way: hero, exchange, payments, credit, privacy, and back.

import { motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { T } from '../../../shared/amm.ts'
import { X } from '../../../shared/exchange.ts'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { VaultStage, type StageScene } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { fmtCompact } from '../ui/bits.tsx'

type Go = (tab: 'trade' | 'payments' | 'lending' | 'lens') => void

const ease = [0.22, 1, 0.36, 1] as const
const REPO = 'https://github.com/mezonquark47/orvane'

export default function Landing({ go }: { go: Go }) {
  return (
    <div className="landing">
      <Hero go={go} />
      {CHAPTERS.map((c, i) => (
        <Chapter key={c.id} chapter={c} flip={i % 2 === 1} go={go} />
      ))}
      <Privacy go={go} />
      <Finale go={go} />
    </div>
  )
}

// ---------------------------------------------------------------- hero

const HEADLINE = [
  ['Money', 'that', 'keeps'],
  ['its', 'own', 'counsel.'],
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
        <span className="ln-pip" /> Private payments &amp; DeFi on the Canton Network
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
          Swap, run payroll, settle invoices and borrow against Canton Coin. Each in one atomic transaction that only its parties can read.
        </p>
        <div className="ln-ctas">
          <button className="ln-btn" onClick={() => go('trade')}>
            Enter the vault <Arrow />
          </button>
          <button className="ln-ghost" onClick={() => document.getElementById('privacy')?.scrollIntoView({ behavior: 'smooth' })}>
            How the privacy works
          </button>
        </div>
      </motion.div>
      <Ticker />
    </section>
  )
}

// What the pool is doing right now, read from the ledger. A new pool version
// means something settled, and the vault pulses.
function usePoolPulse() {
  const { status, config, ledger } = useOrvane()
  const [state, setState] = useState<{ count?: number; last?: number; a?: number; b?: number }>({})

  useEffect(() => {
    if (status !== 'ready' || !config) return
    const tpl = config.exchange ? X.ExchangePool : T.Pool
    const poolId = config.exchange?.poolId ?? config.poolId
    const ofPool = (arg: unknown) => (arg as { poolId?: string }).poolId === poolId
    let alive = true
    let cid: string | undefined
    let timer: ReturnType<typeof setTimeout>

    // the full count once, then only watch the live pool contract
    ledger
      .history(config.operator, [tpl])
      .then((h) => {
        const mine = h.filter((u) => ofPool(u.event.createArgument))
        const at = mine.at(-1)?.at
        if (alive) setState((s) => ({ ...s, count: mine.length, last: at ? Date.parse(at) : s.last }))
      })
      .catch(() => {})

    const tick = async () => {
      try {
        const [p] = (await ledger.query<{ poolId: string; reserveA: string; reserveB: string }>(config.operator, [tpl])).filter((c) => ofPool(c.payload))
        if (alive && p) {
          const moved = cid !== undefined && p.contractId !== cid
          cid = p.contractId
          if (moved) signalSettled()
          setState((s) => ({
            count: moved && s.count !== undefined ? s.count + 1 : s.count,
            last: moved ? Date.now() : s.last,
            a: +p.payload.reserveA,
            b: +p.payload.reserveB,
          }))
        }
      } catch {
        /* keep the last reading */
      }
      if (alive) timer = setTimeout(tick, 2500)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [status, config, ledger])

  return state
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function Ticker() {
  const { status, config } = useOrvane()
  const pool = usePoolPulse()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const cc = config?.exchange ? 'CC' : 'CCx'
  const network = status === 'offline' ? 'Offline' : config?.network === 'localnet' ? 'Canton LocalNet' : status === 'ready' ? 'Local sandbox' : 'Connecting'
  return (
    <motion.div className="ln-ticker" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 1.5 }}>
      <Stat k="Ledger" v={network} live={status === 'ready'} />
      <Stat k="Pool settlements" v={pool.count === undefined ? '—' : pool.count.toLocaleString('en-US')} />
      <Stat k="Last settlement" v={pool.last ? ago(now - pool.last) : '—'} />
      <Stat k="Pool depth" v={pool.a !== undefined && pool.b !== undefined ? `${fmtCompact(pool.a)} USDx · ${fmtCompact(pool.b)} ${cc}` : '—'} />
      <Stat k="Public observers" v="0" accent />
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
  tab: 'trade' | 'payments' | 'lending'
  open: string
  kicker: string
  title: ReactNode
  body: string
  card: ReactNode
  lift?: number
}

const Seal = ({ children }: { children: ReactNode }) => <span className="ln-seal">{children}</span>

const CHAPTERS: ChapterData[] = [
  {
    id: 'exchange',
    n: 'I',
    scene: 'trade',
    tab: 'trade',
    open: 'Open the exchange',
    kicker: 'Exchange',
    title: (
      <>
        One pool, two sides,
        <br />
        <em>no audience.</em>
      </>
    ),
    body: 'A constant-product pool for USDx and Canton Coin. Traders see their own fill and pool members see the price. Nobody sees who traded, or how much.',
    card: (
      <div className="ln-card">
        <div className="ln-card-head">
          <span>Your receipt</span>
          <Seal>only you + operator</Seal>
        </div>
        <div className="ln-big">
          1,000.00 <small>USDx</small>
        </div>
        <div className="ln-arrow" />
        <div className="ln-big brass">
          163,912.41 <small>CC</small>
        </div>
        <div className="ln-row">
          <span>fee 0.30%</span>
          <span>1 transaction</span>
        </div>
      </div>
    ),
  },
  {
    id: 'payments',
    n: 'II',
    scene: 'payments',
    tab: 'payments',
    open: 'Open payments',
    kicker: 'Payments',
    title: (
      <>
        Payroll each person
        <br />
        <em>reads alone.</em>
      </>
    ),
    body: 'One signature pays everyone, each in the currency they chose. Every employee gets a payslip only they can open. The auditor gets the totals and never a name.',
    card: (
      <div className="ln-card">
        <div className="ln-card-head">
          <span>Payslip · November</span>
          <Seal>only Maya + Acme</Seal>
        </div>
        <div className="ln-big">
          4,200.00 <small>USDx</small>
        </div>
        <div className="ln-row">
          <span>paid as</span>
          <span className="verd">688,524.6 CC</span>
        </div>
        <div className="ln-row">
          <span>advance repaid</span>
          <span>300.00 USDx</span>
        </div>
      </div>
    ),
  },
  {
    id: 'credit',
    n: 'III',
    scene: 'lending',
    tab: 'lending',
    open: 'Open credit',
    lift: 0.35,
    kicker: 'Credit',
    title: (
      <>
        Borrow against Canton Coin.
        <br />
        <em>Quietly.</em>
      </>
    ),
    body: 'Lock CC and borrow up to 60% of its value in USDx, priced from the pool. If a loan has to be liquidated, it settles on the ledger between the borrower and the market, not in a public mempool.',
    card: (
      <div className="ln-card">
        <div className="ln-card-head">
          <span>Loan health</span>
          <Seal>only you + market</Seal>
        </div>
        <div className="ln-big">1.48</div>
        <div className="ln-meter">
          <i style={{ width: '62%' }} />
        </div>
        <div className="ln-row">
          <span>250,000 CC locked</span>
          <span>900 USDx owed</span>
        </div>
      </div>
    ),
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
        {c.card}
        <button className="ln-ghost ln-open" onClick={() => go(c.tab)}>
          {c.open} <Arrow />
        </button>
      </motion.div>
    </section>
  )
}

// ---------------------------------------------------------------- privacy

const WHO = ['You', 'Counterparty', 'Operator', 'Auditor', 'Everyone else']
const WHAT: [string, boolean[]][] = [
  ['That you traded', [true, false, true, false, false]],
  ['Pool price', [true, true, true, false, false]],
  ['Your payslip', [true, true, false, false, false]],
  ['Payroll total', [true, false, false, true, false]],
  ['Loan and collateral', [true, false, true, false, false]],
]

function Privacy({ go }: { go: Go }) {
  const [col, setCol] = useState<number | null>(null)
  return (
    <section className="ln-privacy" id="privacy">
      <VaultStage scene="liquidity" className="ln-privacy-stage" />
      <motion.div
        className="ln-privacy-inner"
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ amount: 0.35, once: true }}
        transition={{ duration: 1, ease }}
      >
        <p className="ln-kicker center">
          <span className="ln-pip" /> Sub-transaction privacy
        </p>
        <h2 className="ln-title center">
          Everyone shares the ledger.
          <br />
          <em>Nobody shares the view.</em>
        </h2>
        <div className="ln-matrix" onMouseLeave={() => setCol(null)}>
          <div className="ln-mrow head">
            <span />
            {WHO.map((w, i) => (
              <span key={w} className={col === i ? 'hot' : ''} onMouseEnter={() => setCol(i)}>
                {w}
              </span>
            ))}
          </div>
          {WHAT.map(([what, sees]) => (
            <div className="ln-mrow" key={what}>
              <span className="what">{what}</span>
              {sees.map((s, i) => (
                <span
                  key={i}
                  className={`cell ${s ? 'on' : ''} ${col === i ? 'hot' : ''}`}
                  onMouseEnter={() => setCol(i)}
                  aria-label={`${WHO[i]}: ${s ? 'sees it' : 'does not see it'}`}
                >
                  <i />
                </span>
              ))}
            </div>
          ))}
        </div>
        <p className="ln-note">
          On Canton a party only receives the parts of a transaction it is a stakeholder in. Orvane is built on that, in Daml.{' '}
          <button className="ln-inline" onClick={() => go('lens')}>
            See it live in the privacy lens →
          </button>
        </p>
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
          <button className="ln-btn" onClick={() => go('trade')}>
            Enter the vault <Arrow />
          </button>
          <a className="ln-ghost" href={REPO} target="_blank" rel="noreferrer">
            Read the Daml ↗
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
