// Liquidity: lock both assets in your own account for a term, earn the fee
// on every trade, leave whenever you like.
//
// Nothing is transferred to a pool contract. The deposit is two committed
// allocations in the provider's own account with the operator as executor;
// every swap settles a slice of them. At the end of the term they unlock on
// their own, so the funds come back even if Orvane is gone.

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { ZERO, dec, toNumber, type Dec } from '../../../shared/decimal.ts'
import { DEX, type LpPosition } from '../../../shared/dex.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { useDex, type PoolConfig, type PoolLive } from '../ledger/dex.tsx'
import { Rejected, cancelRequest, deposit, renew, withdraw } from '../ledger/orders.ts'
import { VaultStage } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { useActivity } from '../ui/activity.tsx'
import { ConnectFirst, EyeIcon, Panel, Rolling, SkeletonList, Tilt, TokenGlyph, fmt, glyphFor } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'
import { dateTime, timeLeft } from '../ui/time.ts'

const AMOUNT = /^\d*\.?\d{0,10}$/
const TERMS = [
  { seconds: 600, label: '10 min' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 7 * 86_400, label: '7 days' },
  { seconds: 30 * 86_400, label: '30 days' },
  { seconds: 90 * 86_400, label: '90 days' },
]

const parse = (s: string): Dec => {
  try {
    return s ? dec(s) : ZERO
  } catch {
    return ZERO
  }
}

const termsFor = (pool: PoolConfig) => TERMS.filter((t) => t.seconds >= pool.minTermSeconds && t.seconds <= pool.maxTermSeconds)

export default function Liquidity() {
  const dex = useDex()
  const { config, pools, party, mine, loaded, instrument, free } = dex
  const activity = useActivity()
  const pool = config?.pools[0]
  const live = pool ? pools.get(pool.poolId) : undefined
  const [rawA, setRawA] = useState('')
  const [rawB, setRawB] = useState('')
  const [term, setTerm] = useState<number>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  if (!pool) return null

  const a = instrument(pool.instrumentA)
  const b = instrument(pool.instrumentB)
  const terms = termsFor(pool)
  const termSeconds = term ?? terms.find((t) => t.seconds === 30 * 86_400)?.seconds ?? terms[terms.length - 1]?.seconds ?? pool.minTermSeconds
  const opening = !live || live.positions === 0
  const amountA = parse(rawA)
  // after the first deposit the second side follows the pool price exactly
  const amountB = opening ? parse(rawB) : live && live.reserveA > ZERO ? (amountA * live.reserveB) / live.reserveA : ZERO
  const termEnd = new Date(Date.now() + termSeconds * 1000)
  const short = amountA > free(pool.instrumentA) ? a.label : amountB > free(pool.instrumentB) ? b.label : undefined
  const paused = live?.status === 'Paused'
  const full = live ? live.positions >= pool.maxPositions : false
  const canDeposit = !!party && amountA > ZERO && amountB > ZERO && !short && !busy && !paused && !full

  const positions = mine.positions.filter((p) => p.payload.poolId === pool.poolId)
  const myA = positions.reduce((s, p) => s + toNumber(dec(p.payload.amountA)), 0)
  const share = live && live.reserveA > ZERO ? myA / toNumber(live.reserveA) : 0

  const onDeposit = async () => {
    if (!canDeposit) return
    setBusy('deposit')
    setError(undefined)
    const id = activity.start(`Add liquidity · ${fmt(toNumber(amountA), 4)} ${a.label} + ${fmt(toNumber(amountB), 4)} ${b.label}`, 'Waiting for your signature…')
    try {
      await deposit(dex, { pool, amountA, amountB, termEnd }, () => activity.update(id, { detail: 'Signed. Both sides are locked in your account; the operator opens the position…' }))
      activity.done(id, { detail: `Earning ${fmt(pool.feeBps / 100)}% of every trade until ${dateTime(termEnd)}. Withdraw any time.` })
      setRawA('')
      setRawB('')
      signalSettled()
    } catch (e) {
      setError(e instanceof Rejected ? `Handed back: ${e.message}. Your funds are unlocked.` : errorText(e))
      activity.fail(id, e instanceof Rejected ? e.message : e)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="page page-liquidity">
      <div className="narrative">
        <VaultStage scene="liquidity" />
        <p className="eyebrow">
          Liquidity · {a.label} / {b.label} · funds stay in your wallet
        </p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Provide liquidity
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>without handing it over.</em>
          </motion.span>
        </h1>
        <p className="lede">
          Your deposit never leaves your account. It is locked there for a term you choose, and every trade settles a slice of it. You earn{' '}
          {fmt(pool.feeBps / 100)}% of each trade, can withdraw whenever you like, and when the term ends your funds unlock on their own, even if
          Orvane is offline.
        </p>
        <div className="position">
          <div className="position-share">
            <span className="muted small">Your share of the pool</span>
            <Rolling value={share * 100} digits={3} className="big mono" />
            <span className="unit">%</span>
          </div>
          <div className="position-legs">
            {[a, b].map((i, n) => (
              <div key={i.key}>
                <TokenGlyph symbol={glyphFor(i.key)} size={22} />
                <Rolling value={positions.reduce((s, p) => s + +(n === 0 ? p.payload.amountA : p.payload.amountB), 0)} digits={4} className="mono" />{' '}
                <span className="muted">{i.label}</span>
              </div>
            ))}
          </div>
          <div className="share-bar" aria-hidden>
            <motion.span animate={{ width: `${Math.max(share * 100, share > 0 ? 1.5 : 0)}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} />
          </div>
        </div>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <Tilt className="swap-card">
            <header className="card-head">
              <h2>{opening ? 'Open the pool' : 'Add liquidity'}</h2>
              <span className="muted small">{opening ? 'your deposit sets the price' : 'matched to the pool price'}</span>
            </header>
            <AmountLeg label="Lock" symbol={a} raw={rawA} setRaw={setRawA} balance={free(pool.instrumentA)} connected={!!party} />
            <div className="plus">+</div>
            {opening ? (
              <AmountLeg label="Lock" symbol={b} raw={rawB} setRaw={setRawB} balance={free(pool.instrumentB)} connected={!!party} />
            ) : (
              <div className="leg leg-out">
                <div className="leg-top">
                  <span>Matched automatically</span>
                  {party && <span className="muted">Balance {fmt(toNumber(free(pool.instrumentB)), 4)}</span>}
                </div>
                <div className="leg-main">
                  <Rolling value={toNumber(amountB)} digits={6} className="amount mono out" />
                  <span className="token-chip">
                    <TokenGlyph symbol={glyphFor(b.key)} /> {b.label}
                  </span>
                </div>
              </div>
            )}
            <div className="term-pick" role="radiogroup" aria-label="Term">
              <span className="muted small">Locked until</span>
              <div>
                {terms.map((t) => (
                  <button key={t.seconds} role="radio" aria-checked={termSeconds === t.seconds} className={termSeconds === t.seconds ? 'on' : ''} onClick={() => setTerm(t.seconds)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <dl className="details">
              <div>
                <dt>Unlocks by itself</dt>
                <dd className="mono">{dateTime(termEnd)}</dd>
              </div>
              <div>
                <dt>Withdraw early</dt>
                <dd>any time, through Orvane</dd>
              </div>
              <div>
                <dt>Visible to</dt>
                <dd className="visible-to">
                  <span className="who you">You</span>
                  <span className="who">Operator</span>
                  <span className="who hidden">
                    <EyeIcon closed /> traders, other LPs
                  </span>
                </dd>
              </div>
            </dl>
            {!party ? (
              <ConnectFirst what="provide liquidity" />
            ) : (
              <button className={`primary ${busy === 'deposit' ? 'busy' : ''}`} disabled={!canDeposit} onClick={onDeposit}>
                <span>
                  {paused
                    ? 'The pool is paused'
                    : full
                      ? 'The pool is full'
                      : short
                        ? `Not enough ${short}`
                        : busy === 'deposit'
                          ? 'Locking both sides…'
                          : amountA > ZERO && amountB > ZERO
                            ? 'Lock & provide · one signature'
                            : 'Enter an amount'}
                </span>
              </button>
            )}
            {error && <p className="tx-error">{error}</p>}
          </Tilt>
        </Panel>

        {party && (
          <Panel delay={0.3}>
            <header className="card-head">
              <h3>Your positions</h3>
              <span className="muted small">
                <EyeIcon /> you + operator
              </span>
            </header>
            {mine.deposits.length > 0 && <p className="muted small pending-note">Opening {mine.deposits.length} position(s)…</p>}
            {positions.length === 0 && !loaded ? (
              <SkeletonList rows={2} />
            ) : positions.length === 0 ? (
              <p className="empty">No positions yet. Your deposit stays in your account, locked for the term you choose.</p>
            ) : (
              <ul className="lp-list">
                <AnimatePresence initial={false}>
                  {positions.map((p) => (
                    <PositionRow key={p.contractId} position={p} pool={pool} live={live} busy={busy} setBusy={setBusy} setError={setError} />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </Panel>
        )}
      </div>
    </div>
  )
}

function AmountLeg({ label, symbol, raw, setRaw, balance, connected }: { label: string; symbol: { key: string; label: string }; raw: string; setRaw: (s: string) => void; balance: Dec; connected: boolean }) {
  return (
    <div className="leg">
      <div className="leg-top">
        <span>{label}</span>
        {connected && (
          <button className="link" onClick={() => setRaw(String(Math.floor(toNumber(balance) * 10_000) / 10_000))}>
            Balance {fmt(toNumber(balance), 4)} · Max
          </button>
        )}
      </div>
      <div className="leg-main">
        <input className="amount mono" inputMode="decimal" placeholder="0.00" value={raw} onChange={(e) => AMOUNT.test(e.target.value) && setRaw(e.target.value)} aria-label={`${symbol.label} to lock`} />
        <span className="token-chip">
          <TokenGlyph symbol={glyphFor(symbol.key)} /> {symbol.label}
        </span>
      </div>
    </div>
  )
}

function PositionRow({
  position,
  pool,
  live,
  busy,
  setBusy,
  setError,
}: {
  position: Contract<LpPosition>
  pool: PoolConfig
  live?: PoolLive
  busy?: string
  setBusy: (s?: string) => void
  setError: (s?: string) => void
}) {
  const dex = useDex()
  const activity = useActivity()
  const p = position.payload
  const { instrument, mine } = dex
  const a = instrument(p.instrumentA)
  const b = instrument(p.instrumentB)
  const leaving = mine.withdrawals.find((w) => w.payload.positionId === p.positionId)
  const renewing = mine.renewals.find((r) => r.payload.positionId === p.positionId)
  const share = live && live.reserveA > ZERO ? (+p.amountA / toNumber(live.reserveA)) * 100 : 0
  // renew for the same length again, within the pool's maximum
  const length = Math.min(Date.parse(p.termEnd) - Date.parse(p.openedAt), pool.maxTermSeconds * 1000)
  const renewTo = new Date(Math.min(Date.now() + length, Date.now() + pool.maxTermSeconds * 1000 - 60_000))
  const canRenew = renewTo.getTime() > Date.parse(p.termEnd)

  const run = async (key: string, title: string, fn: () => Promise<unknown>, doneText: string) => {
    setBusy(key)
    setError(undefined)
    try {
      await activity.track(title, fn, { detail: 'Waiting for your signature…', done: () => ({ detail: doneText }) })
      signalSettled()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <motion.li layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }}>
      <div>
        <span className="mono strong">{fmt(+p.amountA, 4)}</span> <span className="muted">{a.label}</span> + <span className="mono strong">{fmt(+p.amountB, 4)}</span>{' '}
        <span className="muted">{b.label}</span>
        <div className="muted small mono">
          {fmt(share, 3)}% of the pool · unlocks {dateTime(p.termEnd)} ({timeLeft(p.termEnd)})
        </div>
      </div>
      <div className="row-actions">
        {leaving ? (
          <button className="ghost small" disabled={!!busy} onClick={() => run(leaving.contractId, 'Keep position', () => cancelRequest(dex, DEX.WithdrawRequest, 'WithdrawRequest_Cancel', leaving.contractId), 'Your position stays in the pool.')}>
            Withdrawing… cancel
          </button>
        ) : (
          <button
            className="ghost small"
            disabled={!!busy}
            onClick={() => run(position.contractId, 'Withdraw liquidity', () => withdraw(dex, p), `${fmt(+p.amountA, 4)} ${a.label} + ${fmt(+p.amountB, 4)} ${b.label} unlocked in your account.`)}
          >
            {busy === position.contractId ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
        {renewing ? (
          <span className="muted small">renewing…</span>
        ) : (
          canRenew && (
            <button
              className="ghost small"
              disabled={!!busy}
              title={`Keep it locked until ${dateTime(renewTo)}`}
              onClick={() => run(`renew-${position.contractId}`, 'Renew position', () => renew(dex, p, renewTo), `Locked until ${dateTime(renewTo)}.`)}
            >
              Renew
            </button>
          )
        )}
      </div>
    </motion.li>
  )
}
