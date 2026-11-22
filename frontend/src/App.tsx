import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { LayoutGroup, motion } from 'motion/react'
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { toNumber } from '../../shared/decimal.ts'
import { DexProvider, useDex } from './ledger/dex.tsx'
import { GATEWAY_URL } from './ledger/gateway.ts'
import type { WalletKind } from './ledger/wallet.ts'
import { ActivityDock, ActivityProvider, Toasts } from './ui/activity.tsx'
import { PageSkeleton, shortParty } from './ui/bits.tsx'
import { errorText } from './ui/errors.ts'
import Landing from './pages/Landing.tsx'
import Liquidity from './pages/Liquidity.tsx'
import Portfolio from './pages/Portfolio.tsx'
import PoolSwap from './pages/PoolSwap.tsx'
import Swap from './pages/Swap.tsx'
import { NETWORK } from './ledger/network.ts'
import { MarketProvider, useMarket } from './swap/market.tsx'

const Vault = lazy(() => import('./three/Vault.tsx'))
import type { VaultScene } from './three/Vault.tsx'

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
        <Tooltip.Provider delayDuration={200}>
          <Shell />
        </Tooltip.Provider>
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
  const { status, config, pools, pulse, mine } = useDex()
  const market = useMarket()
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

  // Orb weights: each side of the pool against its first recorded fill.
  const live = config ? pools.get(config.pools[0]?.poolId ?? '') : undefined
  const weights = useMemo(() => {
    const first = live?.recent[0]
    if (!live || !first || live.reserveA === 0n) return { a: 1, b: 1 }
    const price = toNumber(live.reserveB) / toNumber(live.reserveA)
    return { a: Math.min(1.4, Math.max(0.6, first.price / price)), b: Math.min(1.4, Math.max(0.6, price / first.price)) }
  }, [live])

  const scene: VaultScene = tab === 'home' ? 'hero' : (TABS.find((t) => t.key === tab)?.scene ?? 'trade')
  const incoming = mine.incoming.length

  return (
    <>
      <Suspense fallback={null}>
        <Vault weightA={weights.a} weightB={weights.b} pulse={pulse ? { id: pulse, from: 'CCx' } : null} scene={scene} />
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
                  {tab === 'swap' && (NETWORK.cantex ? <Swap /> : <PoolSwap />)}
                  {tab === 'liquidity' && NETWORK.pool && <Liquidity />}
                  {tab === 'portfolio' && <Portfolio />}
                </>
              )}
            </motion.div>
          </main>
        )}

        <footer className="foot">
          <span>Daml · Canton Network · token standard V2</span>
          <span className="sep" />
          <span>{status === 'ready' && market.status !== 'offline' ? `${NETWORK.label}${NETWORK.cantex ? ' · Cantex liquidity' : ''}` : status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
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
  if (wallet.phase === 'connected') {
    return (
      <div className="wallet">
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className="wallet-party mono">
              <span className="wallet-dot" aria-hidden /> {shortParty(wallet.session.party)}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tip" sideOffset={8}>
              Signed in with {wallet.session.name}. Orvane never sees your keys.
              <Tooltip.Arrow className="tip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
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

  // a CIP-0103 browser-extension wallet, if one is installed
  const [extension, setExtension] = useState(false)
  useEffect(() => {
    if (!open) return
    import('./ledger/wallet.ts').then((w) => w.extensionAvailable().then(setExtension), () => setExtension(false))
  }, [open])

  const customGateway = !!import.meta.env.VITE_WALLET_GATEWAY_URL
  const options: Array<{ kind: WalletKind; name: string; detail: string; available: boolean; note?: string }> = [
    {
      kind: 'loop',
      name: 'Loop',
      detail: 'Five North’s Canton wallet. Swaps any token Cantex lists.',
      available: !!NETWORK.loop,
      note: NETWORK.loop ? `Loop ${NETWORK.loop}` : 'on TestNet and MainNet',
    },
    {
      kind: 'extension',
      name: 'Browser wallet',
      detail: 'Any CIP-0103 wallet installed in this browser.',
      available: extension,
      note: extension ? 'detected' : 'none installed',
    },
    {
      kind: 'gateway',
      name: 'Wallet Gateway',
      detail: NETWORK.gateway ? 'The reference CIP-0103 wallet, running next to LocalNet.' : 'Your organisation’s CIP-0103 Wallet Gateway.',
      available: NETWORK.gateway || customGateway,
      note: NETWORK.gateway || customGateway ? GATEWAY_URL.replace(/\/api.*$/, '') : 'set VITE_WALLET_GATEWAY_URL',
    },
  ]
  const pick = async (kind: WalletKind) => {
    setError(undefined)
    try {
      await connect(kind)
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
              <li key={o.kind}>
                <button disabled={!o.available || wallet.phase === 'connecting'} onClick={() => pick(o.kind)}>
                  <span className="wallet-name">{o.name}</span>
                  <span className="muted small">{o.detail}</span>
                  {o.note && <span className="wallet-note mono small">{o.note}</span>}
                  {wallet.phase === 'connecting' && wallet.kind === o.kind && <span className="wallet-note small">waiting for the wallet…</span>}
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
        <h2>The vault is closed.</h2>
        <p className="muted">Start LocalNet and the Orvane operator, then this page connects by itself.</p>
        <pre className="mono small">{`./scripts/localnet.ps1 up\nnode operator/index.ts`}</pre>
      </motion.div>
    </main>
  )
}
