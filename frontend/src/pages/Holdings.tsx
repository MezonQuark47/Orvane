import { VaultStage } from '../three/stage.tsx'
import { motion } from 'motion/react'
import { useState } from 'react'
import type { InstrumentId } from '../../../shared/amulet.ts'
import { X, sameInstrument, type ExchangePool } from '../../../shared/exchange.ts'
import { useOrvane } from '../ledger/OrvaneProvider.tsx'
import { connectLoop, type LoopSession } from '../ledger/loop.ts'
import { pick, usePolled } from '../ledger/usePolled.ts'
import { useTokenBalances } from '../ledger/useTokenBalances.ts'
import { Panel, Rolling, SkeletonList, TokenGlyph, fmt, shortParty } from '../ui/bits.tsx'
import { useActivity } from '../ui/activity.tsx'

const NONE: InstrumentId = { admin: '', id: '' }
const label = (i: InstrumentId) => (i.id === 'Amulet' ? 'CC' : i.id)
const glyph = (i: InstrumentId) => (i.id === 'Amulet' || i.id === 'CC' ? 'CCx' : i.id)

type Row = { key: string; symbol: string; glyph: string; amount: number; note: string }

export default function Holdings() {
  const { balances, tokens, faucet, pool, party, persona, loaded, config } = useOrvane()
  const ex = config?.exchange
  // token-standard holdings, the ones every flow in the app actually spends
  const std = useTokenBalances(ex?.usdx ?? NONE, ex?.amulet ?? NONE, !!ex)
  const xpool = pick<ExchangePool>(usePolled(ex ? [X.ExchangePool] : []), 'ExchangePool').find((p) => p.payload.poolId === ex?.poolId)?.payload
  const activity = useActivity()
  const [dripping, setDripping] = useState(false)
  const [loopState, setLoopState] = useState<{ session?: LoopSession; error?: string; busy?: boolean }>({})

  const usd = ex ? std.usdx : balances.USDx
  const cc = ex ? std.cc : balances.CCx
  const price = ex ? (xpool && +xpool.reserveB ? +xpool.reserveA / +xpool.reserveB : 0) : (pool?.price ?? 0)
  const total = usd + cc * price
  const usdShare = total ? usd / total : 0.5
  const ccName = ex ? 'CC' : 'CCx'
  const drip = ex ? '500 USDx + 100,000 CC' : '1,000 USDx + 5,000 CCx'

  const rows: Row[] = ex
    ? std.holdings.map((h) => ({
        key: h.contractId,
        symbol: label(h.view.instrumentId),
        glyph: glyph(h.view.instrumentId),
        amount: +h.view.amount,
        note: h.view.lock ? 'locked for settlement' : sameInstrument(h.view.instrumentId, ex.amulet) && ex.realAmulet ? 'Canton Coin' : 'CIP-56',
      }))
    : tokens.map((t) => ({
        key: t.contractId,
        symbol: t.payload.symbol,
        glyph: t.payload.symbol,
        amount: +t.payload.amount,
        note: t.payload.observers.length ? `shared with ${t.payload.observers.length}` : 'private',
      }))
  const rowsLoaded = ex ? std.loaded : loaded

  return (
    <div className="page page-holdings">
      <div className="narrative">
        <VaultStage scene="holdings" weights={[1 + (usdShare - 0.5) * 0.12, 1 + (0.5 - usdShare) * 0.12]} />
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
          {[
            { s: 'USDx', g: 'USDx', v: usd },
            { s: ccName, g: 'CCx', v: cc },
          ].map((b, i) => (
            <motion.div key={b.s} className="balance-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + i * 0.08 }}>
              <TokenGlyph symbol={b.g} size={34} />
              <div>
                <Rolling value={b.v} className="mono strong" />
                <span className="muted small">{b.s}</span>
              </div>
            </motion.div>
          ))}
        </div>
        <button
          className="ghost"
          disabled={dripping}
          onClick={async () => {
            setDripping(true)
            try {
              await activity.track('Test funds', faucet, { detail: drip, done: () => ({ detail: `${drip} minted to you` }) })
            } catch {
              /* shown in the toast and Activity */
            }
            setTimeout(() => setDripping(false), 1200)
          }}
        >
          {dripping ? 'Minting…' : `Request test funds · ${drip}`}
        </button>
      </div>

      <div className="rail">
        <Panel delay={0.15}>
          <header className="card-head">
            <h3>Holding contracts</h3>
            <span className="muted small mono">{party ? shortParty(party) : ''}</span>
          </header>
          <ul className="holding-list">
            {rows.map((r) => (
              <li key={r.key}>
                <TokenGlyph symbol={r.glyph} size={20} />
                <span className="mono strong">{fmt(r.amount)}</span>
                <span className="muted">{r.symbol}</span>
                <span className="obs small">{r.note}</span>
              </li>
            ))}
            {rows.length === 0 && (rowsLoaded ? <li className="empty">No holdings yet.</li> : <li className="empty"><SkeletonList rows={2} /></li>)}
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
