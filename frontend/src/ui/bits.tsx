import { animate, motion, useMotionValue } from 'motion/react'
import { useEffect, useId, useMemo, useRef } from 'react'
import type { PricePoint } from '../ledger/OrvaneProvider.tsx'

export const fmt = (n: number, digits = 2) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '–'

export const fmtCompact = (n: number) =>
  n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })

export const shortParty = (p: string) => {
  const [name, hash] = p.split('::')
  return hash ? `${name}::${hash.slice(0, 4)}…${hash.slice(-4)}` : p
}

// Number that rolls to its new value instead of jumping.
export function Rolling({ value, digits = 2, className }: { value: number; digits?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const mv = useMotionValue(value)
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1] })
    return controls.stop
  }, [value, mv])
  useEffect(
    () =>
      mv.on('change', (v) => {
        if (ref.current) ref.current.textContent = fmt(v, digits)
      }),
    [mv, digits],
  )
  return (
    <span ref={ref} className={className}>
      {fmt(value, digits)}
    </span>
  )
}

export function TokenGlyph({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const usd = symbol === 'USDx'
  return (
    <span className={`glyph ${usd ? 'glyph-usd' : 'glyph-cc'}`} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 32 32" width={size} height={size}>
        {usd ? (
          <>
            <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M16 7v18M20.5 11.5c-1-1.4-2.6-2-4.5-2-2.6 0-4.3 1.3-4.3 3.2 0 4.6 9 2.4 9 7 0 2-1.9 3.3-4.7 3.3-2 0-3.8-.8-4.8-2.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </>
        ) : (
          <>
            <path d="M16 3l11.3 6.5v13L16 29 4.7 22.5v-13z" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M20.5 12.2A6 6 0 1 0 20.5 19.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  )
}

export function Sparkline({ points, width = 420, height = 96 }: { points: PricePoint[]; width?: number; height?: number }) {
  const id = useId()
  const { line, area, last } = useMemo(() => {
    if (points.length < 2) return { line: '', area: '', last: null as null | { x: number; y: number } }
    const xs = points.map((_, i) => i)
    const ys = points.map((p) => p.price)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const pad = (maxY - minY || maxY * 0.01) * 0.25
    const sx = (i: number) => (i / (xs.length - 1)) * width
    const sy = (v: number) => height - ((v - (minY - pad)) / (maxY - minY + 2 * pad)) * height
    // step line: price is constant between trades
    let d = `M0 ${sy(ys[0])}`
    for (let i = 1; i < ys.length; i++) d += ` H${sx(i)} V${sy(ys[i])}`
    return { line: d, area: `${d} V${height} H0 Z`, last: { x: sx(xs.length - 1), y: sy(ys[ys.length - 1]) } }
  }, [points, width, height])

  if (!line) return <div className="spark-empty">Price history appears after the first trade.</div>
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Pool price history">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--brass)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--brass)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#${id}-fill)`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }} />
      <motion.path
        d={line}
        fill="none"
        stroke="var(--brass)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
      />
      {last && <circle cx={last.x} cy={last.y} r="3.5" fill="var(--brass)" className="spark-dot" />}
    </svg>
  )
}

export function EyeIcon({ closed = false }: { closed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {closed && <path d="M3 3l18 18" />}
    </svg>
  )
}

export function Panel({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.section
      className={`panel ${className}`}
      initial={{ opacity: 0, y: 24, rotateX: 8 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.section>
  )
}

// Tilts toward the pointer for a little physical depth.
export function Tilt({ children, className = '', max = 6 }: { children: React.ReactNode; className?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const onMove = (e: React.PointerEvent) => {
    const el = ref.current
    if (!el || e.pointerType !== 'mouse') return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    animate(ry, px * max, { duration: 0.4 })
    animate(rx, -py * max, { duration: 0.4 })
    el.style.setProperty('--gx', `${(px + 0.5) * 100}%`)
    el.style.setProperty('--gy', `${(py + 0.5) * 100}%`)
  }
  const onLeave = () => {
    animate(rx, 0, { duration: 0.6 })
    animate(ry, 0, { duration: 0.6 })
  }
  return (
    <motion.div ref={ref} className={`tilt ${className}`} style={{ rotateX: rx, rotateY: ry }} onPointerMove={onMove} onPointerLeave={onLeave}>
      {children}
    </motion.div>
  )
}
