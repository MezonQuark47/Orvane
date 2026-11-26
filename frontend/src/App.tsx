import * as Dialog from '@radix-ui/react-dialog'
import { LayoutGroup, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { DexProvider, useDex } from './ledger/dex.tsx'
import { GATEWAY_URL } from './ledger/gateway.ts'
import type { ExtensionWallet, WalletKind } from './ledger/wallet.ts'
import { ActivityDock, ActivityProvider, Toasts } from './ui/activity.tsx'
import { PageSkeleton } from './ui/bits.tsx'
import { errorText } from './ui/errors.ts'
import Landing from './pages/Landing.tsx'
import Portfolio from './pages/Portfolio.tsx'
import Swap from './pages/Swap.tsx'
import { NETWORK, VENUE } from './ledger/network.ts'
import { MarketProvider, useMarket } from './swap/market.tsx'

import { startKinetic } from './ui/kinetic.ts'
import { WalletMenu } from './ui/WalletMenu.tsx'
import { scrollToTarget, startSmoothScroll } from './ui/smooth.ts'
import type { StageScene } from './three/stage.tsx'

const Particles = lazy(() => import('./three/Particles.tsx'))
// the Orvane pool's pages run on LocalNet only; other networks never load them
const Liquidity = lazy(() => import('./pages/Liquidity.tsx'))
const PoolSwap = lazy(() => import('./pages/PoolSwap.tsx'))
const Markets = lazy(() => import('./pages/Markets.tsx'))
const HowItWorks = lazy(() => import('./pages/HowItWorks.tsx'))

// Phones get a still backdrop instead of the live particles, so they never
// download three.js or spend battery on it.
const STILL = window.matchMedia('(max-width: 640px), (pointer: coarse) and (max-height: 500px)').matches
if (STILL) document.documentElement.classList.add('still-vault')

const ALL_TABS = [
  { key: 'swap', label: 'Swap', scene: 'trade' },
  { key: 'markets', label: 'Markets', scene: 'markets' },
  { key: 'liquidity', label: 'Liquidity', scene: 'liquidity' },
  { key: 'portfolio', label: 'Portfolio', scene: 'holdings' },
  { key: 'how', label: 'How it works', scene: 'how' },
] as const
// Liquidity is the Orvane pool, kept for later; it only shows where the pool runs (LocalNet).
// Markets lists the venue's pools, so it only shows where there is a venue.
const TABS = ALL_TABS.filter((t) => (t.key !== 'liquidity' || NETWORK.pool) && (t.key !== 'markets' || VENUE))
// 'home' is the landing; it has no tab of its own, the wordmark leads there
export type Tab = (typeof ALL_TABS)[number]['key'] | 'home'

export default function App() {
  return (
    <DexProvider>
      <MarketProvider>
      <ActivityProvider>
        <Shell />
      </ActivityProvider>
      </MarketProvider>
    </DexProvider>
  )
}

function readTab(): Tab {
  const h = window.location.hash.slice(1)
  return TABS.find((t) => t.key === h)?.key ?? 'home'
}

function Shell() {
  const { status, pulse, mine } = useDex()
  const market = useMarket()
  const [tab, setTab] = useState<Tab>(readTab)
  useEffect(() => {
    const on = () => setTab(readTab())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  useEffect(() => startSmoothScroll(), [])
  useEffect(() => startKinetic(), [])
  // every section starts at its top
  useEffect(() => {
    scrollToTarget(0, true)
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

  const pulseKey = useMemo(() => (pulse ? { id: pulse } : null), [pulse])
  const scene: StageScene = tab === 'home' ? 'hero' : (TABS.find((t) => t.key === tab)?.scene ?? 'trade')
  const incoming = mine.incoming.length

  return (
    <>
      {STILL ? (
        <div className="still-backdrop" aria-hidden />
      ) : (
        <Suspense fallback={null}>
          <Particles scene={scene} pulse={pulseKey} />
        </Suspense>
      )}
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
                  {t.key === 'portfolio' && incoming > 0 && <span className="tab-badge">{incoming}</span>}
                </button>
              ))}
            </nav>
          </LayoutGroup>
          <WalletMenu />
        </header>

        {(status === 'offline' || market.status === 'offline') && tab !== 'home' ? (
          <Offline />
        ) : (
          <main className={tab === 'home' ? 'is-landing' : undefined}>
            {/* A brass light sweeps the top edge on every section change. */}
            <motion.span
              key={`sweep-${tab}`}
              className="sweep"
              aria-hidden
              initial={{ scaleX: 0, opacity: 1 }}
              animate={{ scaleX: 1, opacity: 0 }}
              transition={{ scaleX: { duration: 0.9, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.5, delay: 0.7 } }}
            />
            {/* Enter-only transition: a keyed remount can't get stuck waiting on an exit. */}
            <motion.div
              key={`${tab}-${tab !== 'home' && status}`}
              initial={{ opacity: 0, y: 14, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            >
              {tab === 'home' && <Landing go={go} />}
              {tab !== 'home' && status === 'connecting' && <PageSkeleton />}
              {status === 'ready' && (
                <>
                  {tab === 'swap' &&
                    (VENUE ? (
                      <Swap />
                    ) : (
                      <Suspense fallback={<PageSkeleton />}>
                        <PoolSwap />
                      </Suspense>
                    ))}
                  {tab === 'liquidity' && NETWORK.pool && (
                    <Suspense fallback={<PageSkeleton />}>
                      <Liquidity />
                    </Suspense>
                  )}
                  {tab === 'portfolio' && <Portfolio />}
                  {tab === 'markets' && VENUE && (
                    <Suspense fallback={<PageSkeleton />}>
                      <Markets />
                    </Suspense>
                  )}
                  {tab === 'how' && (
                    <Suspense fallback={<PageSkeleton />}>
                      <HowItWorks />
                    </Suspense>
                  )}
                </>
              )}
            </motion.div>
          </main>
        )}

        <footer className="foot">
          {/* swaps through Loop are token standard V1 transfers; the Orvane pool (LocalNet) runs on V2 */}
          <span>Daml · Canton Network · token standard {NETWORK.pool ? 'V2' : 'V1'}</span>
          <span className="sep" />
          <span>{status === 'ready' && market.status !== 'offline' ? `${NETWORK.label}${VENUE ? ` · ${VENUE} liquidity` : ''}` : status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
          <span className={`live ${status}`} aria-hidden />
        </footer>
      </div>

      <Toasts />
      <ActivityDock hidden={tab === 'home' || status !== 'ready'} />
      <ConnectDialog />
    </>
  )
}


// The wallets that speak CIP-0103 on this network.
function ConnectDialog() {
  const { connect, wallet } = useDex()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    const on = () => {
      setError(undefined)
      setOpen(true)
    }
    window.addEventListener('orvane:connect', on)
    return () => window.removeEventListener('orvane:connect', on)
  }, [])
  useEffect(() => {
    if (wallet.phase === 'connected') setOpen(false)
  }, [wallet.phase])

  // CIP-0103 browser-extension wallets: each one that announces itself, or,
  // when none does, whichever extension answers
  const [extensions, setExtensions] = useState<ExtensionWallet[]>([])
  const [anyExtension, setAnyExtension] = useState(false)
  useEffect(() => {
    if (!open) return
    import('./ledger/wallet.ts').then(
      (w) => {
        w.extensionWallets().then(setExtensions, () => setExtensions([]))
        w.extensionAvailable().then(setAnyExtension, () => setAnyExtension(false))
      },
      () => setAnyExtension(false),
    )
  }, [open])

  const customGateway = !!import.meta.env.VITE_WALLET_GATEWAY_URL
  type Option = { key: string; kind: WalletKind; extension?: ExtensionWallet; name: string; icon?: string; detail: string; available: boolean; note?: string }
  const browserWallets: Option[] = extensions.length
    ? extensions.map((x) => ({ key: `ext:${x.id}`, kind: 'extension', extension: x, name: x.name, icon: x.icon, detail: 'Installed in this browser.', available: true, note: 'browser extension' }))
    : [
        {
          key: 'extension',
          kind: 'extension',
          name: 'Browser wallet',
          detail: 'Any CIP-0103 wallet installed in this browser.',
          available: anyExtension,
          note: anyExtension ? 'detected' : 'none installed',
        },
      ]
  const options: Option[] = [
    {
      key: 'loop',
      kind: 'loop',
      name: 'Loop',
      detail: `Five North’s Canton wallet. Swaps any token ${VENUE ?? 'Cantex'} lists.`,
      available: !!NETWORK.loop,
      note: NETWORK.loop ? `Loop ${NETWORK.loop}` : 'on TestNet and MainNet',
    },
    ...browserWallets,
    {
      key: 'gateway',
      kind: 'gateway',
      name: 'Wallet Gateway',
      detail: NETWORK.gateway ? 'The reference CIP-0103 wallet, running next to LocalNet.' : 'Your organisation’s CIP-0103 Wallet Gateway.',
      available: NETWORK.gateway || customGateway,
      note: GATEWAY_URL.replace(/\/api.*$/, ''),
    },
    // a gateway only shows where one is set up; it is an organisation's tool, not something a user installs
  ].filter((o) => o.kind !== 'gateway' || o.available) as Option[]
  // which option the user picked, to show the wait on it
  const [picked, setPicked] = useState<string>()
  const pick = async (o: Option) => {
    setError(undefined)
    setPicked(o.key)
    try {
      await connect(o.kind, o.extension)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog wallet-dialog">
          <div className="wallet-dialog-head">
            <p className="eyebrow">{NETWORK.label}</p>
            <Dialog.Title>Connect a wallet</Dialog.Title>
            <Dialog.Close className="wallet-dialog-x" aria-label="Close">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted wallet-dialog-lede">Pick the wallet you use on {NETWORK.label}.</Dialog.Description>
          <ul className="wallet-options">
            {options.map((o) => {
              const waiting = wallet.phase === 'connecting' && picked === o.key
              return (
                <li key={o.key}>
                  <button className={waiting ? 'is-waiting' : ''} disabled={!o.available || wallet.phase === 'connecting'} onClick={() => pick(o)}>
                    <span className="wallet-tile" aria-hidden>
                      {/* an extension's own icon, when it is inline data (the site's CSP allows no other images) */}
                      {o.icon?.startsWith('data:image/') ? <img src={o.icon} alt="" width={22} height={22} /> : <span>{o.name.slice(0, 1)}</span>}
                    </span>
                    <span className="wallet-option-text">
                      <span className="wallet-name">{o.name}</span>
                      <span className="muted small">{o.detail}</span>
                      {o.note && <span className="wallet-note mono small">{o.note}</span>}
                    </span>
                    <span className="wallet-option-end" aria-hidden>
                      {waiting ? (
                        <span className="wallet-spin" />
                      ) : !o.available ? (
                        <span className="wallet-badge mono">Unavailable</span>
                      ) : (
                        <svg viewBox="0 0 16 16" width="14" height="14">
                          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    {waiting && <span className="sr-only">waiting for the wallet</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          {error && <p className="tx-error">{error}</p>}
          <p className="wallet-dialog-foot small">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
              <rect x="3" y="7" width="10" height="7" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            You approve every swap in the wallet itself. Orvane never sees your keys and can&apos;t move anything on its own.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Offline() {
  return (
    <main className="offline">
      <motion.div className="panel" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        {VENUE ? (
          <>
            <h2>Can't reach {VENUE} right now.</h2>
            <p className="muted">Prices and pools come from {VENUE}. This page keeps trying and picks up again by itself; check your connection in the meantime.</p>
          </>
        ) : (
          <>
            <h2>Orvane is offline.</h2>
            <p className="muted">Start LocalNet and the Orvane operator, then this page connects by itself.</p>
            <pre className="mono small">{`./scripts/localnet.ps1 up\nnode operator/index.ts`}</pre>
          </>
        )}
      </motion.div>
    </main>
  )
}
