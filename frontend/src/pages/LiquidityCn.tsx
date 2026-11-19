// Liquidity on the token-standard pool: the same USDx / CC pool the exchange
// trades against. Both sides go in as CIP-56 allocations in one signature and
// come back out as an LP share only the provider and the operator can see.

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { Scan, type InstrumentId } from '../../../shared/amulet.ts'
import type { Contract } from '../../../shared/ledger.ts'
import { X, registries, type ExchangePool } from '../../../shared/exchange.ts'
import { newRef } from '../../../shared/credit.ts'
import { LQ, cancelLpWithdraw, lpWithdrawRequest, prepareDeposit, type LpBook, type LpShare, type LpWithdrawRequest } from '../../../shared/liquidity.ts'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { pick, usePolledState } from '../ledger/usePolled.ts'
import { useTokenBalances } from '../ledger/useTokenBalances.ts'
import { VaultStage } from '../three/stage.tsx'
import { signalSettled } from '../three/settle.ts'
import { useActivity } from '../ui/activity.tsx'
import { EyeIcon, Panel, Rolling, SkeletonList, Tilt, TokenGlyph, fmt } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'

const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)
const glyph = (i: InstrumentId) => (i.id === 'Amulet' || i.id === 'CC' ? 'CCx' : i.id)

export default function LiquidityCn() {
  const { config, ledger, party } = useOrvane()
  const ex = config!.exchange!
  const activity = useActivity()
  const { rows, loaded } = usePolledState([X.ExchangePool, LQ.LpBook, LQ.LpShare, LQ.LpDepositRequest, LQ.LpWithdrawRequest], 1300)
  const balances = useTokenBalances(ex.usdx, ex.amulet)
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const pool = pick<ExchangePool>(rows, 'ExchangePool').find((p) => p.payload.poolId === ex.poolId)?.payload
  const book = pick<LpBook>(rows, 'LpBook').find((b) => b.payload.poolId === ex.poolId)?.payload
  const shares = pick<LpShare>(rows, 'LpShare').filter((s) => s.payload.owner === party)
  const deposits = pick(rows, 'LpDepositRequest')
  const withdrawals = pick<LpWithdrawRequest>(rows, 'LpWithdrawRequest').filter((w) => w.payload.provider === party)

  const resA = pool ? +pool.reserveA : 0
  const resB = pool ? +pool.reserveB : 0
  const total = book ? +book.totalShares : 0
  const amountA = Number(raw) || 0
  const amountB = resA ? Math.ceil(((amountA * resB) / resA) * 1e4) / 1e4 : 0
  const minted = total && resA ? (amountA * total) / resA : 0

  const myShares = shares.reduce((s, l) => s + +l.payload.shares, 0)
  const ownership = total ? myShares / total : 0
  const short = amountA > balances.usdx ? 'USDx' : amountB > balances.cc ? 'CC' : null
  const pending = deposits.length > 0
  const canDeposit = !!pool && !!book && amountA > 0 && !short && !busy && !pending

  const reg = () => registries(ledger, new Scan(''), ex.realAmulet ? ex.amulet.admin : '')

  const deposit = async () => {
    if (!canDeposit || !party || !pool) return
    setBusy('deposit')
    setError(undefined)
    try {
      await activity.track(
        `Add liquidity · ${fmt(amountA)} USDx`,
        async () => {
          // shares are quoted on today's reserves; allow 1% for trades landing first
          const { command, disclosed } = await prepareDeposit({
            ledger,
            reg: reg(),
            provider: party,
            operator: config!.operator,
            poolId: ex.poolId,
            instrA: pool.instrA,
            amountA,
            instrB: pool.instrB,
            amountB,
            minShares: minted * 0.99,
            ref: newRef('lp'),
          })
          await ledger.submit([party], [command], [], disclosed)
        },
        {
          detail: `${fmt(amountA)} USDx + ${fmt(amountB, 0)} CC`,
          done: () => ({ detail: `${fmt(amountA)} USDx + ${fmt(amountB, 0)} CC locked. The operator mints your share in a moment.` }),
        },
      )
      setRaw('')
      signalSettled('USDx')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  const withdraw = async (share: Contract<LpShare>) => {
    if (!party) return
    const f = total ? +share.payload.shares / total : 0
    setBusy(share.contractId)
    setError(undefined)
    try {
      await activity.track('Withdraw liquidity', () => ledger.submit([party], [lpWithdrawRequest(party, config!.operator, share.contractId)]), {
        detail: `≈ ${fmt(resA * f)} USDx + ${fmt(resB * f, 0)} CC`,
        done: () => ({ detail: `Requested ≈ ${fmt(resA * f)} USDx + ${fmt(resB * f, 0)} CC. The operator pays it out in a moment.` }),
      })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  const cancel = async (w: Contract<LpWithdrawRequest>) => {
    if (!party) return
    setBusy(w.contractId)
    try {
      await activity.track('Cancel withdrawal', () => ledger.submit([party], [cancelLpWithdraw(w.contractId)]), { done: () => ({ detail: 'Your share stays in the pool.' }) })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="page page-liquidity">
      <div className="narrative">
        <VaultStage scene="liquidity" />
        <p className="eyebrow">Liquidity · USDx / CC · CIP-56</p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Earn on every
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>quiet trade.</em>
          </motion.span>
        </h1>
        <p className="lede">
          This is the pool every swap, payroll conversion and loan prices against. Providers earn its {pool ? fmt(+pool.feeBps / 100) : '0.30'}% fee. Your
          share is a contract only you and the operator can see: other members know the pool is deep, not who made it so.
        </p>
        <div className="position">
          <div className="position-share">
            <span className="muted small">Your share of the pool</span>
            <Rolling value={ownership * 100} digits={3} className="big mono" />
            <span className="unit">%</span>
          </div>
          <div className="position-legs">
            <div>
              <TokenGlyph symbol="USDx" size={22} />
              <Rolling value={resA * ownership} className="mono" /> <span className="muted">USDx</span>
            </div>
            <div>
              <TokenGlyph symbol="CCx" size={22} />
              <Rolling value={resB * ownership} digits={0} className="mono" /> <span className="muted">CC</span>
            </div>
          </div>
          <div className="share-bar" aria-hidden>
            <motion.span animate={{ width: `${Math.max(ownership * 100, ownership > 0 ? 1.5 : 0)}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} />
          </div>
        </div>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <Tilt className="swap-card">
            <header className="card-head">
              <h2>Add liquidity</h2>
              <span className="muted small">ratio locked to the pool</span>
            </header>
            <div className="leg">
              <div className="leg-top">
                <span>Deposit</span>
                <button
                  className="link"
                  onClick={() => {
                    if (!resA || !resB) return
                    const maxByCc = (balances.cc * resA) / resB
                    setRaw(String(Math.floor(Math.min(balances.usdx, maxByCc) * 100) / 100))
                  }}
                >
                  Balance {fmt(balances.usdx)} · Max
                </button>
              </div>
              <div className="leg-main">
                <input
                  className="amount mono"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={raw}
                  onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setRaw(e.target.value)}
                  aria-label="USDx to deposit"
                />
                <span className="token-chip">
                  <TokenGlyph symbol="USDx" /> USDx
                </span>
              </div>
            </div>
            <div className="plus">+</div>
            <div className="leg leg-out">
              <div className="leg-top">
                <span>Matched automatically</span>
                <span className="muted">Balance {fmt(balances.cc, 0)}</span>
              </div>
              <div className="leg-main">
                <Rolling value={amountB} digits={2} className="amount mono out" />
                <span className="token-chip">
                  <TokenGlyph symbol={pool ? glyph(pool.instrB) : 'CCx'} /> {pool ? label(pool.instrB) : 'CC'}
                </span>
              </div>
            </div>
            {amountA > 0 && total > 0 && (
              <dl className="details">
                <div>
                  <dt>Shares minted</dt>
                  <dd className="mono">≈ {fmt(minted, 2)}</dd>
                </div>
                <div>
                  <dt>Your share after</dt>
                  <dd className="mono">{fmt(((myShares + minted) / (total + minted)) * 100, 3)}%</dd>
                </div>
              </dl>
            )}
            <button className={`primary ${busy === 'deposit' ? 'busy' : ''}`} disabled={!canDeposit} onClick={deposit}>
              <span>
                {short
                  ? `Not enough ${short}`
                  : busy === 'deposit'
                    ? 'Locking both sides…'
                    : pending
                      ? 'The operator is settling…'
                      : amountA > 0
                        ? 'Add liquidity · one signature'
                        : 'Enter an amount'}
              </span>
            </button>
            {error && <p className="tx-error">{error}</p>}
          </Tilt>
        </Panel>

        <Panel delay={0.3}>
          <header className="card-head">
            <h3>Your positions</h3>
            <span className="muted small">
              <EyeIcon /> you + operator
            </span>
          </header>
          {shares.length === 0 && !loaded ? (
            <SkeletonList rows={2} />
          ) : shares.length === 0 ? (
            <p className="empty">No positions yet. A deposit mints an LP share contract to your party.</p>
          ) : (
            <ul className="lp-list">
              <AnimatePresence initial={false}>
                {shares.map((l) => {
                  const f = total ? +l.payload.shares / total : 0
                  const waiting = withdrawals.find((w) => w.payload.shareCid === l.contractId)
                  return (
                    <motion.li key={l.contractId} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 30 }}>
                      <div>
                        <span className="mono strong">{fmt(+l.payload.shares, 2)}</span> <span className="muted">shares</span>
                        <div className="muted small mono">
                          ≈ {fmt(resA * f)} USDx + {fmt(resB * f, 0)} CC
                        </div>
                      </div>
                      {waiting ? (
                        <button className="ghost" disabled={busy === waiting.contractId} onClick={() => cancel(waiting)} title="The operator hasn't paid this out yet">
                          Cancel withdrawal
                        </button>
                      ) : (
                        <button className="ghost" disabled={!!busy} onClick={() => withdraw(l)}>
                          {busy === l.contractId ? 'Signing…' : 'Withdraw'}
                        </button>
                      )}
                    </motion.li>
                  )
                })}
              </AnimatePresence>
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
