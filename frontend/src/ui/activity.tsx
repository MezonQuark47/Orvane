// Everything the user signs goes through here: a toast while it runs and when
// it lands, and an entry in the Activity drawer afterwards. History is kept in
// this browser only (per network), the same way a wallet keeps its own list.

import { AnimatePresence, motion } from 'motion/react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { fmt } from './bits.tsx'
import { explain, type Explained } from './errors.ts'

export type ActivityStatus = 'pending' | 'done' | 'failed'

export interface Activity {
  id: string
  at: number
  updated: number
  title: string
  detail?: string
  who?: string
  status: ActivityStatus
  error?: Explained
  /** the toast was closed or timed out */
  seen?: boolean
}

type Patch = { title?: string; detail?: string }

// Actions are stable across renders, so pages can call them from effects
// without re-running every time a toast changes.
interface ActivityActions {
  start: (title: string, detail?: string) => string
  update: (id: string, patch: Patch) => void
  done: (id: string, patch?: Patch) => void
  fail: (id: string, e: unknown) => void
  /** Run `fn` as one tracked action; errors are recorded and rethrown. */
  track: <T>(title: string, fn: () => Promise<T>, opts?: { detail?: string; done?: (r: T) => Patch | void }) => Promise<T>
}

interface ActivityFeed {
  items: Activity[]
  dismiss: (id: string) => void
  clear: () => void
  open: boolean
  setOpen: (open: boolean) => void
}

const Actions = createContext<ActivityActions | null>(null)
const Feed = createContext<ActivityFeed | null>(null)
const KEEP = 60

let seq = 0
const newId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`

function load(key: string): Activity[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as Activity[]
    // a reload mid-flight leaves entries pending forever; close them out
    return raw.map((a) =>
      a.status === 'pending'
        ? { ...a, status: 'failed', seen: true, error: { title: 'Interrupted', hint: 'The page closed before this finished. Check your balances.', raw: 'page reloaded' } }
        : { ...a, seen: true },
    )
  } catch {
    return []
  }
}

const LEGACY_TITLES = { swap: 'Swap', deposit: 'Add liquidity', withdraw: 'Withdraw liquidity' } as const

export function ActivityProvider({ children }: { children: ReactNode }) {
  const { config, persona, tx } = useOrvane()
  const key = config ? `orvane.activity.${config.network ?? 'sandbox'}` : undefined
  const [items, setItems] = useState<Activity[]>([])
  const [open, setOpen] = useState(false)
  const who = useRef<string | undefined>(undefined)
  who.current = persona?.name

  // load once the network is known, and only save into the list we loaded
  const loadedKey = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!key) return
    loadedKey.current = key
    setItems(load(key))
  }, [key])
  useEffect(() => {
    if (!key || loadedKey.current !== key) return
    try {
      localStorage.setItem(key, JSON.stringify(items.slice(0, KEEP)))
    } catch {
      /* storage full or blocked; history stays in memory */
    }
  }, [items, key])

  const patch = useCallback((id: string, p: Partial<Activity>) => setItems((xs) => xs.map((a) => (a.id === id ? { ...a, ...p, updated: Date.now() } : a))), [])

  const start = useCallback((title: string, detail?: string) => {
    const id = newId()
    const now = Date.now()
    setItems((xs) => [{ id, at: now, updated: now, title, detail, who: who.current, status: 'pending' as const }, ...xs].slice(0, KEEP))
    return id
  }, [])
  const update = useCallback((id: string, p: Patch) => patch(id, p), [patch])
  const done = useCallback((id: string, p?: Patch) => patch(id, { ...p, status: 'done', seen: false }), [patch])
  const fail = useCallback((id: string, e: unknown) => patch(id, { status: 'failed', error: explain(e), seen: false }), [patch])
  const track = useCallback(
    async <T,>(title: string, fn: () => Promise<T>, opts?: { detail?: string; done?: (r: T) => Patch | void }) => {
      const id = start(title, opts?.detail)
      try {
        const r = await fn()
        done(id, opts?.done?.(r) ?? undefined)
        return r
      } catch (e) {
        fail(id, e)
        throw e
      }
    },
    [start, done, fail],
  )
  const dismiss = useCallback((id: string) => patch(id, { seen: true }), [patch])
  const clear = useCallback(() => setItems((xs) => xs.filter((a) => a.status === 'pending')), [])

  // the legacy pool's swap/deposit/withdraw run through the provider's own tx state
  const legacy = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!tx.kind) return
    if (tx.phase === 'signing') {
      legacy.current = start(LEGACY_TITLES[tx.kind])
      return
    }
    const id = legacy.current
    if (!id) return
    if (tx.phase === 'settling') update(id, { detail: 'Signed. The operator is settling it…' })
    if (tx.phase === 'done') {
      const r = tx.receipt
      done(id, { detail: r ? `${fmt(+r.amountIn)} ${r.symbolIn} → ${fmt(+r.amountOut, 4)} ${r.symbolOut}` : 'Settled' })
      legacy.current = undefined
    }
    if (tx.phase === 'error') {
      fail(id, tx.message)
      legacy.current = undefined
    }
  }, [tx.phase, tx.kind, tx.receipt, tx.message, start, update, done, fail])

  const actions = useMemo<ActivityActions>(() => ({ start, update, done, fail, track }), [start, update, done, fail, track])
  const feed = useMemo<ActivityFeed>(() => ({ items, dismiss, clear, open, setOpen }), [items, dismiss, clear, open])
  return (
    <Actions.Provider value={actions}>
      <Feed.Provider value={feed}>{children}</Feed.Provider>
    </Actions.Provider>
  )
}

export function useActivity() {
  const v = useContext(Actions)
  if (!v) throw new Error('useActivity outside ActivityProvider')
  return v
}

function useFeed() {
  const v = useContext(Feed)
  if (!v) throw new Error('activity feed outside ActivityProvider')
  return v
}

// ---------------------------------------------------------------- toasts

export function Toasts() {
  const { items, dismiss, setOpen } = useFeed()
  const live = items.filter((a) => !a.seen && (a.status !== 'pending' || Date.now() - a.at < 120_000)).slice(0, 4)
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      <AnimatePresence initial={false}>
        {live.map((a) => (
          <Toast key={a.id} a={a} onClose={() => dismiss(a.id)} onOpen={() => setOpen(true)} />
        ))}
      </AnimatePresence>
    </div>
  )
}

function Toast({ a, onClose, onOpen }: { a: Activity; onClose: () => void; onOpen: () => void }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (a.status === 'pending') return
    const t = setTimeout(() => close.current(), a.status === 'failed' ? 9000 : 4800)
    return () => clearTimeout(t)
  }, [a.status, a.updated])

  const [head, line] =
    a.status === 'failed'
      ? [a.error?.title ?? 'Failed', a.error?.hint ? `${a.title}: ${a.error.hint}` : `${a.title} didn't go through.`]
      : a.status === 'done'
        ? [a.title, a.detail ?? 'Settled on the ledger']
        : [a.title, a.detail ?? 'Waiting for your signature…']

  return (
    <motion.div
      layout
      className={`toast ${a.status}`}
      initial={{ opacity: 0, y: 18, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 48, transition: { duration: 0.25 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
    >
      <StatusMark status={a.status} />
      <button className="toast-body" onClick={onOpen}>
        <strong>{head}</strong>
        <span>{line}</span>
      </button>
      <button className="toast-x" onClick={onClose} aria-label="Dismiss">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </motion.div>
  )
}

function StatusMark({ status }: { status: ActivityStatus }) {
  return (
    <span className={`mark-status ${status}`} aria-label={status === 'pending' ? 'In progress' : status === 'done' ? 'Done' : 'Failed'}>
      {status === 'done' && (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {status === 'failed' && (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M8 4v5M8 11.6v.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </span>
  )
}

// ---------------------------------------------------------------- drawer

const ago = (t: number, now: number) => {
  const s = Math.round((now - t) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ActivityDock({ hidden }: { hidden?: boolean }) {
  const { items, open, setOpen, clear } = useFeed()
  const { config } = useOrvane()
  const pending = items.filter((a) => a.status === 'pending').length
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 15_000)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', esc)
    return () => {
      clearInterval(id)
      window.removeEventListener('keydown', esc)
    }
  }, [open, setOpen])

  return (
    <>
      {!hidden && (
        <button className={`dock ${pending ? 'busy' : ''}`} onClick={() => setOpen(true)} aria-label={`Activity${pending ? `, ${pending} in progress` : ''}`}>
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden>
            <path d="M3 10a7 7 0 1 0 2.05-4.95" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M3 3.5V6.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 6.5V10l2.5 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {pending > 0 && <span className="dock-count">{pending}</span>}
        </button>
      )}

      <AnimatePresence>
        {open && (
          <>
            <motion.div className="drawer-veil" onClick={() => setOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside
              className="drawer"
              role="dialog"
              aria-label="Activity"
              initial={{ x: '104%' }}
              animate={{ x: 0 }}
              exit={{ x: '104%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 36 }}
            >
              <header className="drawer-head">
                <div>
                  <h2>Activity</h2>
                  <p className="muted small">What you signed from this browser on {config?.network === 'localnet' ? 'Canton LocalNet' : 'the local sandbox'}.</p>
                </div>
                <button className="toast-x" onClick={() => setOpen(false)} aria-label="Close">
                  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                    <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              </header>

              {items.length === 0 ? (
                <div className="drawer-empty">
                  <span className="mark-status done" aria-hidden />
                  <p>Nothing yet.</p>
                  <p className="muted small">Swaps, payroll runs, invoices and loans you sign show up here, with what happened to each.</p>
                </div>
              ) : (
                <ol className="feed">
                  {items.map((a) => (
                    <li key={a.id} className={a.status}>
                      <StatusMark status={a.status} />
                      <div className="feed-main">
                        <div className="feed-top">
                          <strong>{a.title}</strong>
                          <time className="muted small" dateTime={new Date(a.at).toISOString()}>
                            {ago(a.at, now)}
                          </time>
                        </div>
                        {a.status === 'failed' && a.error ? (
                          <>
                            <p className="feed-err">{a.error.title}</p>
                            {a.error.hint && <p className="muted small">{a.error.hint}</p>}
                            {a.error.raw && a.error.raw !== a.error.title && (
                              <details>
                                <summary>Ledger message</summary>
                                <code>{a.error.raw}</code>
                              </details>
                            )}
                          </>
                        ) : (
                          a.detail && <p className="feed-detail mono">{a.detail}</p>
                        )}
                        {a.who && <span className="feed-who">as {a.who}</span>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {items.some((a) => a.status !== 'pending') && (
                <footer className="drawer-foot">
                  <button className="chip-btn ghosty" onClick={clear}>
                    Clear history
                  </button>
                </footer>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
