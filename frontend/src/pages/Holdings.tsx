import { motion } from 'motion/react'
import { useState } from 'react'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { connectLoop, type LoopSession } from '../ledger/loop.ts'
import { Panel, Rolling, TokenGlyph, fmt, shortParty } from '../ui/bits.tsx'

export default function Holdings() {
  const { balances, tokens, faucet, pool, party, persona } = useOrvane()
  const [dripping, setDripping] = useState(false)
  const [loopState, setLoopState] = useState<{ session?: LoopSession; error?: string; busy?: boolean }>({})
  const total = balances.USDx + balances.CCx * (pool?.price ?? 0)

  return (
    <div className="page page-holdings">
      <div className="narrative">
        <p className="eyebrow">Holdings · {persona?.name}</p>
        <h1 className="display">
          <motion.span className="line" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
            Yours, and
          </motion.span>
          <motion.span className="line accent" initial={{ y: '110%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}>
            <em>only yours.</em>
          </motion.span>
        </h1>
        <div className="networth">
          <span className="muted small">Portfolio value</span>
          <div>
            <span className="unit">$</span>
            <Rolling value={total} className="big mono" />
          </div>
        </div>
        <div className="balances">
          {(['USDx', 'CCx'] as const).map((s, i) => (
            <motion.div key={s} className="balance-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.08 }}>
              <TokenGlyph symbol={s} size={34} />
              <div>
                <Rolling value={balances[s]} className="mono strong" />
                <span className="muted small">{s}</span>
              </div>
            </motion.div>
          ))}
        </div>
        <button
          className="ghost"
          disabled={dripping}
          onClick={async () => {
            setDripping(true)
            await faucet()
            setTimeout(() => setDripping(false), 1200)
          }}
        >
          {dripping ? 'Minting…' : 'Request test funds · 1,000 USDx + 5,000 CCx'}
        </button>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <header className="card-head">
            <h3>Holding contracts</h3>
            <span className="muted small mono">{party ? shortParty(party) : ''}</span>
          </header>
          <ul className="holding-list">
            {tokens.map((t) => (
              <li key={t.contractId}>
                <TokenGlyph symbol={t.payload.symbol} size={20} />
                <span className="mono strong">{fmt(+t.payload.amount)}</span>
                <span className="muted">{t.payload.symbol}</span>
                <span className="obs small">{t.payload.observers.length ? `shared with ${t.payload.observers.length}` : 'private'}</span>
              </li>
            ))}
            {tokens.length === 0 && <li className="empty">No holdings yet.</li>}
          </ul>
        </Panel>

        <Panel delay={0.3} className="loop-card">
          <header className="card-head">
            <h3>Loop wallet</h3>
            <span className="badge">Canton DevNet</span>
          </header>
          {loopState.session ? (
            <div className="loop-session">
              <p className="mono small">{shortParty(loopState.session.party)}</p>
              <ul className="holding-list">
                {loopState.session.holdings.map((h) => (
                  <li key={h.symbol}>
                    <span className="mono strong">{fmt(h.amount)}</span>
                    <span className="muted">{h.symbol}</span>
                    <span className="obs small">{h.org}</span>
                  </li>
                ))}
                {loopState.session.holdings.length === 0 && <li className="empty">No DevNet holdings. Tap the faucet in Loop.</li>}
              </ul>
              <p className="muted small">
                Orvane's contracts aren't on DevNet yet. Once they are, trades here will be signed in Loop with the same one-signature flow.
              </p>
            </div>
          ) : (
            <>
              <p className="muted">Connect a Five North Loop wallet to see your real Canton Coin balance on DevNet.</p>
              <button
                className="primary slim"
                disabled={loopState.busy}
                onClick={async () => {
                  setLoopState({ busy: true })
                  try {
                    setLoopState({ session: await connectLoop() })
                  } catch (e) {
                    setLoopState({ error: e instanceof Error ? e.message : String(e) })
                  }
                }}
              >
                <span>{loopState.busy ? 'Waiting for Loop…' : 'Connect Loop'}</span>
              </button>
              {loopState.error && <p className="tx-error">{loopState.error}</p>}
            </>
          )}
        </Panel>
      </div>
    </div>
  )
}
