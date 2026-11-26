// Choosing a token: search by symbol, name or issuer. The tokens you hold come
// first, then the deepest pools. Each row names the token's issuer, since
// symbols alone can look alike (USDCx and USDC.B are different tokens).

import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { sameInstrument, type Token } from '../../../shared/cantex.ts'
import { VENUE } from '../ledger/network.ts'
import { TokenIcon, fmt, fmtCompact } from '../ui/bits.tsx'

interface Props {
  tokens: Token[]
  value?: Token
  /** the token on the other side of the swap; picking it swaps the sides */
  other?: Token
  side: 'pay' | 'receive'
  /** free balance, when a wallet is connected */
  balance?: (t: Token) => number
  /** how deep the token's deepest pool at the venue is, in CC */
  depth: (t: Token) => number
  onChange: (t: Token) => void
}

const issuer = (t: Token) => t.admin.split('::')[0]

export function TokenPicker({ tokens, value, other, side, balance, depth, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const held = (t: Token) => (balance?.(t) ?? 0) > 0
    return tokens
      .filter((t) => !q || [t.symbol, t.name, t.id, issuer(t)].some((s) => s.toLowerCase().includes(q)))
      .sort((a, b) => Number(held(b)) - Number(held(a)) || depth(b) - depth(a))
  }, [tokens, query, balance, depth])

  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const pick = (t: Token) => {
    onChange(t)
    setOpen(false)
  }
  const label = side === 'pay' ? 'the token you pay' : 'the token you receive'

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        setQuery('')
        setActive(0)
      }}
    >
      <Dialog.Trigger asChild>
        <button className="token-chip token-trigger" aria-label={`Choose ${label}${value ? `, now ${value.symbol}` : ''}`}>
          {value && <TokenIcon symbol={value.symbol} />}
          <span>{value?.symbol ?? 'Choose'}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog picker"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            input.current?.focus()
          }}
        >
          <Dialog.Title>{side === 'pay' ? 'You send' : 'You receive'}</Dialog.Title>
          <Dialog.Description className="muted small">Every token {VENUE} lists. Check the issuer: two tokens can share a symbol.</Dialog.Description>
          <input
            ref={input}
            className="picker-search"
            placeholder="Search by symbol, name or issuer"
            value={query}
            role="combobox"
            aria-label={`Search ${label}`}
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={rows[active] ? `${id}-${active}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, rows.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter' && rows[active]) {
                e.preventDefault()
                pick(rows[active])
              }
            }}
          />
          {rows.length === 0 ? (
            <p className="picker-empty muted">
              {query.trim() ? <>No token matches “{query.trim()}”.</> : <>{VENUE}’s tokens are still loading.</>}
            </p>
          ) : (
            <ul ref={list} id={`${id}-list`} className="picker-list" role="listbox" aria-label={label}>
              {rows.map((t, i) => {
                const held = balance?.(t) ?? 0
                const deep = depth(t)
                const current = !!value && sameInstrument(t, value)
                const swaps = !!other && sameInstrument(t, other)
                return (
                  <li
                    key={`${t.admin}|${t.id}`}
                    id={`${id}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={`picker-row ${i === active ? 'active' : ''} ${current ? 'current' : ''}`}
                    onClick={() => pick(t)}
                    onMouseMove={() => i !== active && setActive(i)}
                  >
                    <TokenIcon symbol={t.symbol} size={32} />
                    <span className="picker-names">
                      <span className="picker-symbol">
                        {t.symbol}
                        {current && <span className="picker-tag">selected</span>}
                        {swaps && <span className="picker-tag">swaps sides</span>}
                      </span>
                      <span className="picker-meta">
                        {t.name !== t.symbol && `${t.name} · `}
                        <span className="mono">{issuer(t)}</span>
                      </span>
                    </span>
                    <span className="picker-figures mono">
                      {held > 0 && <span className="strong">{fmt(held, 4)}</span>}
                      <span className="muted">{deep > 0 ? `${fmtCompact(deep)} CC deep` : 'no pool'}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <Dialog.Close className="link small dialog-close">Close</Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
