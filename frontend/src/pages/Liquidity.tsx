import { VaultStage } from '../three/stage.tsx'
import { motion } from 'motion/react'
import { useState } from 'react'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { EyeIcon, Panel, Rolling, SkeletonList, Tilt, TokenGlyph, fmt } from '../ui/bits.tsx'
import { errorText } from '../ui/errors.ts'

export default function Liquidity() {
  const { pool, lpShares, balances, deposit, withdraw, tx, loaded } = useOrvane()
  const [raw, setRaw] = useState('')
  const amountA = Number(raw) || 0
  const amountB = pool && pool.reserveA ? (amountA * pool.reserveB) / pool.reserveA : 0

  const myShares = lpShares.reduce((s, l) => s + Number(l.payload.shares), 0)
  const ownership = pool && pool.totalShares ? myShares / pool.totalShares : 0
  const myA = (pool?.reserveA ?? 0) * ownership
  const myB = (pool?.reserveB ?? 0) * ownership

  const busy = tx.phase === 'signing' || tx.phase === 'settling'
  const short = amountA > balances.USDx ? 'USDx' : amountB > balances.CCx ? 'CCx' : null
  const canDeposit = !!pool && amountA > 0 && !short && !busy

  return (
    <div className="page page-liquidity">
      <div className="narrative">
        <VaultStage scene="liquidity" />
        <p className="eyebrow">Liquidity · USDx / CCx</p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Earn on every
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>quiet trade.</em>
          </motion.span>
        </h1>
        <p className="lede">
          Liquidity providers collect the 0.30% fee on every swap. Your position is a contract only you and the operator can see: other members
          know the pool is deep, not who made it so.
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
              <Rolling value={myA} className="mono" /> <span className="muted">USDx</span>
            </div>
            <div>
              <TokenGlyph symbol="CCx" size={22} />
              <Rolling value={myB} className="mono" /> <span className="muted">CCx</span>
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
                    if (!pool) return
                    const maxByB = (balances.CCx * pool.reserveA) / pool.reserveB
                    setRaw(String(Math.floor(Math.min(balances.USDx, maxByB) * 100) / 100))
                  }}
                >
                  Max
                </button>
              </div>
              <div className="leg-main">
                <input
                  className="amount mono"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={raw}
                  onChange={(e) => /^\d*\.?\d{0,6}$/.test(e.target.value) && setRaw(e.target.value)}
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
                <span className="muted">Balance {fmt(balances.CCx)}</span>
              </div>
              <div className="leg-main">
                <Rolling value={amountB} digits={4} className="amount mono out" />
                <span className="token-chip">
                  <TokenGlyph symbol="CCx" /> CCx
                </span>
              </div>
            </div>
            <button className="primary" disabled={!canDeposit} onClick={() => canDeposit && deposit(amountA, amountB)}>
              <span>
                {short ? `Not enough ${short}` : tx.kind === 'deposit' && busy ? 'Settling…' : amountA > 0 ? 'Sign deposit' : 'Enter an amount'}
              </span>
            </button>
            {tx.kind === 'deposit' && tx.phase === 'done' && <p className="tx-ok">Deposit settled. Your LP position updated.</p>}
            {tx.kind === 'deposit' && tx.phase === 'error' && <p className="tx-error">{errorText(tx.message)}</p>}
          </Tilt>
        </Panel>

        <Panel delay={0.3}>
          <header className="card-head">
            <h3>Your positions</h3>
            <span className="muted small">
              <EyeIcon /> you + operator
            </span>
          </header>
          {lpShares.length === 0 && !loaded ? (
            <SkeletonList rows={2} />
          ) : lpShares.length === 0 ? (
            <p className="empty">No positions. Deposits mint an LP share contract to your party.</p>
          ) : (
            <ul className="lp-list">
              {lpShares.map((l) => {
                const share = pool?.totalShares ? Number(l.payload.shares) / pool.totalShares : 0
                return (
                  <li key={l.contractId}>
                    <div>
                      <span className="mono strong">{fmt(Number(l.payload.shares), 2)}</span> <span className="muted">shares</span>
                      <div className="muted small mono">
                        ≈ {fmt((pool?.reserveA ?? 0) * share)} USDx + {fmt((pool?.reserveB ?? 0) * share)} CCx
                      </div>
                    </div>
                    <button className="ghost" disabled={busy} onClick={() => withdraw(l)}>
                      {tx.kind === 'withdraw' && busy ? 'Settling…' : 'Withdraw'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {tx.kind === 'withdraw' && tx.phase === 'done' && <p className="tx-ok">Withdrawn to your wallet.</p>}
          {tx.kind === 'withdraw' && tx.phase === 'error' && <p className="tx-error">{errorText(tx.message)}</p>}
        </Panel>
      </div>
    </div>
  )
}
