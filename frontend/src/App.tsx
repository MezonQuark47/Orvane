import * as Tooltip from '@radix-ui/react-tooltip'
import { LayoutGroup, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { OrvaneProvider, useOrvane } from './ledger/OrvaneProvider.tsx'
import { ActivityDock, ActivityProvider, Toasts } from './ui/activity.tsx'
import { PageSkeleton } from './ui/bits.tsx'
import Holdings from './pages/Holdings.tsx'
import Landing from './pages/Landing.tsx'
import Lens from './pages/Lens.tsx'
import Liquidity from './pages/Liquidity.tsx'
import LiquidityCn from './pages/LiquidityCn.tsx'
import Payments from './pages/Payments.tsx'
import Lending from './pages/Lending.tsx'
import LendingCn from './pages/LendingCn.tsx'
import Trade from './pages/Trade.tsx'
import ExchangeTrade from './pages/ExchangeTrade.tsx'

const Vault = lazy(() => import('./three/Vault.tsx'))
import type { VaultScene } from './three/Vault.tsx'

const TABS = [
  { key: 'trade', label: 'Trade' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'payments', label: 'Payments' },
  { key: 'lending', label: 'Lending' },
  { key: 'lens', label: 'Privacy lens' },
  { key: 'holdings', label: 'Holdings' },
] as const
// 'home' is the landing; it has no tab of its own, the wordmark leads there
type Tab = (typeof TABS)[number]['key'] | 'home'

export default function App() {
  return (
    <OrvaneProvider>
      <ActivityProvider>
        <Tooltip.Provider delayDuration={200}>
          <Shell />
        </Tooltip.Provider>
      </ActivityProvider>
    </OrvaneProvider>
  )
}

function readTab(): Tab {
  const h = window.location.hash.slice(1)
  return TABS.find((t) => t.key === h)?.key ?? 'home'
}

function Shell() {
  const { status, history, pool, pulse, persona, config } = useOrvane()
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => {
    const on = () => setTab(readTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // every section starts at its top, with the vault in its stage
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [tab])
  // the top bar picks up a glass backdrop once the page moves under it
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  const go = (t: Tab) => {
    if (t === 'home') window.history.pushState(null, '', window.location.pathname + window.location.search)
    else window.location.hash = t
    setTab(t)
  }

  // Orb weights: each side's reserve relative to the pool's first seeded state.
  const weights = useMemo(() => {
    const seed = history[0]
    if (!pool || !seed) return { a: 1, b: 1 }
    return { a: pool.reserveA / seed.reserveA, b: pool.reserveB / seed.reserveB }
  }, [pool, history])

  return (
    <>
      <Suspense fallback={null}>
        <Vault weightA={weights.a} weightB={weights.b} pulse={pulse} scene={(tab === 'home' ? 'hero' : tab) as VaultScene} />
      </Suspense>
      <div className="vignette" aria-hidden />

      <div className="app">
        <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
          <a
            className="wordmark"
            href="/"
            onClick={(e) => {
              e.preventDefault()
              go('home')
            }}
          >
            <span className="mark" aria-hidden>
              <i />
              <i />
            </span>
            Orvane
          </a>
          <LayoutGroup>
            <nav className="tabs" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => go(t.key)} aria-current={tab === t.key ? 'page' : undefined}>
                  {tab === t.key && <motion.span className="tab-bg" layoutId="tab-bg" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}
                  <span className="tab-label">{t.label}</span>
                </button>
              ))}
            </nav>
          </LayoutGroup>
          <PersonaSwitch />
        </header>

        {status === 'offline' && tab !== 'home' ? (
          <Offline />
        ) : (
          <main className={tab === 'home' ? 'is-landing' : undefined}>
            {/* A brass light sweeps the top edge on every section change. */}
            <motion.span
              key={`sweep-${tab}-${persona?.key ?? ''}`}
              className="sweep"
              aria-hidden
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: 1, opacity: 0 }}
              transition={{ scaleX: { duration: 0.9, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.5, delay: 0.7 } }}
            />
            {/* Enter-only transition: a keyed remount can't get stuck waiting on an exit. */}
            <motion.div
              key={`${tab}-${persona?.key ?? ''}-${tab !== 'home' && status}`}
              initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              {tab === 'home' && <Landing go={go} />}
              {tab !== 'home' && status === 'connecting' && <PageSkeleton />}
              {status === 'ready' && (
                <>
                  {tab === 'trade' && (config?.exchange ? <ExchangeTrade /> : <Trade />)}
                  {tab === 'liquidity' && (config?.exchange ? <LiquidityCn /> : <Liquidity />)}
                  {tab === 'payments' && <Payments />}
                  {tab === 'lending' && (config?.exchange?.creditMarketId ? <LendingCn /> : <Lending />)}
                  {tab === 'lens' && <Lens />}
                  {tab === 'holdings' && <Holdings />}
                </>
              )}
            </motion.div>
          </main>
        )}

        <footer className="foot">
          <span>Daml · Canton Network</span>
          <span className="sep" />
          <span>{status === 'ready' ? `Connected to ${config?.network === 'localnet' ? 'Canton LocalNet' : 'local sandbox'}` : status === 'connecting' ? 'Connecting…' : 'Ledger offline'}</span>
          <span className={`live ${status}`} aria-hidden />
        </footer>
      </div>

      <Toasts />
      <ActivityDock hidden={tab === 'home' || status !== 'ready'} />
    </>
  )
}

function PersonaSwitch() {
  const { config, persona, setPersona } = useOrvane()
  if (!config) return <div className="personas" />
  return (
    <div className="personas" role="radiogroup" aria-label="Act as">
      <span className="act-as">Act as</span>
      {config.personas.map((p, i) => (
        <Tooltip.Root key={p.key}>
          {i > 0 && p.group !== config.personas[i - 1].group && <span className="persona-sep" aria-hidden />}
          <Tooltip.Trigger asChild>
            <button
              role="radio"
              aria-checked={persona?.key === p.key}
              aria-label={`${p.name}, ${p.role}`}
              className={`avatar av-${p.key} ${p.group === 'business' ? 'org' : ''} ${persona?.key === p.key ? 'on' : ''}`}
              onClick={() => setPersona(p.key)}
            >
              {personaGlyph(p.key, p.name)}
            </button>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tip" sideOffset={8}>
              <strong>{p.name}</strong> · {p.role}
              <Tooltip.Arrow className="tip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      ))}
    </div>
  )
}

export const personaGlyph = (key: string, name: string) => (key === 'auditor' ? '§' : name[0])

function Offline() {
  return (
    <main className="offline">
      <motion.div className="panel" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <h2>The vault is closed.</h2>
        <p className="muted">Start the local Canton sandbox and the operator, then this page connects by itself.</p>
        <pre className="mono small">{`./scripts/sandbox.ps1\ncd operator; npm start`}</pre>
      </motion.div>
    </main>
  )
}
