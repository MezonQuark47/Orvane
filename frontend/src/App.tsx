import * as Dialog from '@radix-ui/react-dialog'
import { LayoutGroup, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useId, useMemo, useState } from 'react'
import { DexProvider, useDex } from './ledger/dex.tsx'
import { GATEWAY_URL } from './ledger/gateway.ts'
import type { ExtensionWallet, WalletKind } from './ledger/wallet.ts'
import { ActivityDock, ActivityProvider, Toasts } from './ui/activity.tsx'
import { PageSkeleton, shortParty } from './ui/bits.tsx'
import { errorText } from './ui/errors.ts'
import Landing from './pages/Landing.tsx'
import Portfolio from './pages/Portfolio.tsx'
import Swap from './pages/Swap.tsx'
import { NETWORK, VENUE } from './ledger/network.ts'
import { MarketProvider, useMarket } from './swap/market.tsx'

import { scrollToTarget, startSmoothScroll } from './ui/smooth.ts'
import type { StageScene } from './three/stage.tsx'

const Particles = lazy(() => import('./three/Particles.tsx'))
// the Orvane pool's pages run on LocalNet only; other networks never load them
const Liquidity = lazy(() => import('./pages/Liquidity.tsx'))
const PoolSwap = lazy(() => import('./pages/PoolSwap.tsx'))

// Phones get a still backdrop instead of the live particles, so they never
// download three.js or spend battery on it.
const STILL = window.matchMedia('(max-width: 640px), (pointer: coarse) and (max-height: 500px)').matches
if (STILL) document.documentElement.classList.add('still-vault')

const ALL_TABS = [
  { key: 'swap', label: 'Swap', scene: 'trade' },
  { key: 'liquidity', label: 'Liquidity', scene: 'liquidity' },
  { key: 'portfolio', label: 'Portfolio', scene: 'holdings' },
] as const
// Liquidity is the Orvane pool, kept for later; it only shows where the pool runs (LocalNet).
const TABS = ALL_TABS.filter((t) => t.key !== 'liquidity' || NETWORK.pool)
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
          <WalletButton />
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


function WalletButton() {
  const { wallet, disconnect } = useDex()
  const tip = useId()
  // the full party id goes to the clipboard; the tip says so for a moment
  const [copied, setCopied] = useState<'yes' | 'no'>()
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(undefined), 1600)
    return () => clearTimeout(t)
  }, [copied])
  if (wallet.phase === 'connected') {
    const party = wallet.session.party
    const copy = () =>
      navigator.clipboard.writeText(party).then(
        () => setCopied('yes'),
        () => setCopied('no'),
      )
    return (
      <div className="wallet">
        <span className={`has-tip ${copied ? 'tip-on' : ''}`}>
          <button className="wallet-party mono" onClick={copy} aria-describedby={tip} aria-label={`Copy your party id ${party}`}>
            <span className="wallet-dot" aria-hidden /> {shortParty(party)}
          </button>
          <span id={tip} role="tooltip" className="tip" aria-live="polite">
            {copied === 'yes'
              ? 'Party id copied.'
              : copied === 'no'
                ? 'Could not copy; your browser blocked the clipboard.'
                : `Signed in with ${wallet.session.name}. Click to copy your party id. Orvane never sees your keys.`}
          </span>
        </span>
        <button className="link small" onClick={() => disconnect()}>
          Disconnect
        </button>
      </div>
    )
  }
  return (
    <div className="wallet">
      <button className="wallet-connect" onClick={() => window.dispatchEvent(new CustomEvent('orvane:connect'))} disabled={wallet.phase === 'connecting'}>
        {wallet.phase === 'connecting' ? 'Connecting…' : 'Connect wallet'}
      </button>
    </div>
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
      note: NETWORK.gateway || customGateway ? GATEWAY_URL.replace(/\/api.*$/, '') : 'set VITE_WALLET_GATEWAY_URL',
    },
  ]
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
          <Dialog.Title>Connect a wallet</Dialog.Title>
          <Dialog.Description className="muted">
            You sign every action in your wallet. Orvane reads only your own contracts, through the wallet, and never holds your keys.
          </Dialog.Description>
          <ul className="wallet-options">
            {options.map((o) => (
              <li key={o.key}>
                <button disabled={!o.available || wallet.phase === 'connecting'} onClick={() => pick(o)}>
                  <span className="wallet-name">
                    {/* an extension's own icon, when it is inline data (the site's CSP allows no other images) */}
                    {o.icon?.startsWith('data:image/') && <img className="wallet-icon" src={o.icon} alt="" width={18} height={18} />}
                    {o.name}
                  </span>
                  <span className="muted small">{o.detail}</span>
                  {o.note && <span className="wallet-note mono small">{o.note}</span>}
                  {wallet.phase === 'connecting' && picked === o.key && <span className="wallet-note small">waiting for the wallet…</span>}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="tx-error">{error}</p>}
          <Dialog.Close className="link small dialog-close">Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Offline() {
  return (
    <main className="offline">
      <motion.div className="panel" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <h2>Orvane is offline.</h2>
        <p className="muted">Start LocalNet and the Orvane operator, then this page connects by itself.</p>
        <pre className="mono small">{`./scripts/localnet.ps1 up\nnode operator/index.ts`}</pre>
      </motion.div>
    </main>
  )
}
