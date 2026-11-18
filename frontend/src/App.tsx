import * as Tooltip from '@radix-ui/react-tooltip'
import { LayoutGroup, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { OrvaneProvider, useOrvane } from './ledger/OrvaneProvider.tsx'
import Holdings from './pages/Holdings.tsx'
import Lens from './pages/Lens.tsx'
import Liquidity from './pages/Liquidity.tsx'
import Payments from './pages/Payments.tsx'
import Lending from './pages/Lending.tsx'
import LendingCn from './pages/LendingCn.tsx'
import Trade from './pages/Trade.tsx'
import ExchangeTrade from './pages/ExchangeTrade.tsx'

const Vault = lazy(() => import('./three/Vault.tsx'))

const TABS = [
  { key: 'trade', label: 'Trade' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'payments', label: 'Payments' },
  { key: 'lending', label: 'Lending' },
  { key: 'lens', label: 'Privacy lens' },
  { key: 'holdings', label: 'Holdings' },
] as const
type Tab = (typeof TABS)[number]['key']

export default function App() {
  return (
    <OrvaneProvider>
      <Tooltip.Provider delayDuration={200}>
        <Shell />
      </Tooltip.Provider>
    </OrvaneProvider>
  )
}

function readTab(): Tab {
  const h = window.location.hash.slice(1)
  return (TABS.find((t) => t.key === h)?.key ?? 'trade') as Tab
}

function Shell() {
  const { status, history, pool, pulse, persona, config } = useOrvane()
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => {
    const on = () => setTab(readTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const go = (t: Tab) => {
    window.location.hash = t
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
        <Vault weightA={weights.a} weightB={weights.b} pulse={pulse} focus={tab === 'lens' || tab === 'payments' ? 1 : 0} />
      </Suspense>
      <div className="grain" aria-hidden />
      <div className="vignette" aria-hidden />

      <div className="app">
        <header className="topbar">
          <a className="wordmark" href="#trade" onClick={() => go('trade')}>
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

        {status === 'offline' ? (
          <Offline />
        ) : (
          <main>
            {/* Enter-only transition: a keyed remount can't get stuck waiting on an exit. */}
            <motion.div
              key={`${tab}-${persona?.key ?? ''}`}
              initial={{ opacity: 0, filter: 'blur(10px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.4 }}
            >
              {tab === 'trade' && (config?.exchange ? <ExchangeTrade /> : <Trade />)}
              {tab === 'liquidity' && <Liquidity />}
              {tab === 'payments' && <Payments />}
              {tab === 'lending' && (config?.exchange?.creditMarketId ? <LendingCn /> : <Lending />)}
              {tab === 'lens' && <Lens />}
              {tab === 'holdings' && <Holdings />}
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
