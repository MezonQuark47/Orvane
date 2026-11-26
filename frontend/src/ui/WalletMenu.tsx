// The wallet in the top bar. Signed out it is one warm-white button; signed
// in it is a quiet chip (a small orb drawn from the party id, the wallet's
// name and the short party) that opens a menu with the full party id, a
// copy button, the network, and Disconnect.

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { useDex } from '../ledger/dex.tsx'
import { NETWORK } from '../ledger/network.ts'

// FNV-1a: a stable number from the party id, so each party gets its own orb
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A small orb in the two token colours, turned and lit by the party id. */
export function PartyOrb({ party, size = 22 }: { party: string; size?: number }) {
  const h = hash(party)
  const style = {
    '--orb-a': `${h % 360}deg`,
    '--orb-x': `${25 + ((h >>> 9) % 50)}%`,
    '--orb-y': `${20 + ((h >>> 17) % 40)}%`,
    width: size,
    height: size,
  } as CSSProperties
  return <span className="party-orb" style={style} aria-hidden />
}

// A party id as a person can tell it apart at a glance: the start of its name
// and the end of its key, e.g. "88476c…f219".
function compactParty(party: string) {
  const [hint, key = ''] = party.split('::')
  return `${hint.slice(0, 6)}…${key.slice(-4)}`
}

function WalletGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
      <path d="M2.5 4.5h9.5a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z M2.5 4.5 10 2.6v1.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="10.8" cy="8.8" r="1" fill="currentColor" />
    </svg>
  )
}

export function WalletMenu() {
  const { wallet, disconnect } = useDex()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'yes' | 'no'>()
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // the menu closes on Escape, on a click outside it, and when the wallet goes
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])
  useEffect(() => {
    if (wallet.phase !== 'connected') setOpen(false)
  }, [wallet.phase])
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(undefined), 1600)
    return () => clearTimeout(t)
  }, [copied])

  if (wallet.phase !== 'connected') {
    const connecting = wallet.phase === 'connecting'
    return (
      <div className="wallet">
        <button className="wallet-connect" onClick={() => window.dispatchEvent(new CustomEvent('orvane:connect'))} disabled={connecting}>
          {connecting ? <span className="wallet-spin" aria-hidden /> : <WalletGlyph />}
          <span>{connecting ? 'Connecting…' : 'Connect wallet'}</span>
        </button>
      </div>
    )
  }

  const { party, name } = wallet.session
  const copy = () =>
    navigator.clipboard.writeText(party).then(
      () => setCopied('yes'),
      () => setCopied('no'),
    )

  return (
    <div className="wallet" ref={root}>
      <button
        className={`wallet-chip ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Wallet ${name}, party ${compactParty(party)}. Open the wallet menu.`}
      >
        <span className="wallet-chip-orb">
          <PartyOrb party={party} />
          <span className="wallet-live" aria-hidden />
        </span>
        <span className="wallet-chip-text">
          <span className="wallet-chip-name">{name}</span>
          <span className="wallet-chip-party mono">{compactParty(party)}</span>
        </span>
        <svg className="wallet-chev" viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="wallet-menu" id={menuId} role="dialog" aria-label="Your wallet">
          <div className="wallet-menu-head">
            <PartyOrb party={party} size={40} />
            <div>
              <div className="wallet-menu-name">{name}</div>
              <div className="wallet-menu-net mono">
                <span className="wallet-live inline" aria-hidden /> Connected · {NETWORK.label}
              </div>
            </div>
          </div>

          <div className="wallet-menu-party">
            <span className="wallet-menu-label mono">Party id</span>
            <code className="mono">{party}</code>
            <button className="wallet-copy" onClick={copy} aria-live="polite">
              {copied === 'yes' ? (
                <>
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                    <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Copied
                </>
              ) : copied === 'no' ? (
                'Clipboard blocked'
              ) : (
                <>
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
                    <rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M3 10.5V4a1.5 1.5 0 0 1 1.5-1.5H11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                  Copy
                </>
              )}
            </button>
          </div>

          <p className="wallet-menu-note">You approve every swap in {name}. Orvane never sees your keys.</p>

          <button className="wallet-disconnect" onClick={() => disconnect()}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              <path d="M8 1.8v5.4M4.6 3.9a5.4 5.4 0 1 0 6.8 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}
