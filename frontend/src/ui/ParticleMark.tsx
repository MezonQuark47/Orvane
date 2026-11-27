// The header's Orvane mark (see particleMark.ts). It turns slowly when the
// system allows motion and the page is visible; otherwise it holds still.

import { useEffect, useMemo, useRef } from 'react'
import { markDots, spherePoints } from './particleMark.ts'

// one full turn every 20 s, redrawn at most 30 times a second
const TURN_MS = 20000
const FRAME_MS = 1000 / 30

export function ParticleMark({ n = 76, dot = 1.75, className = 'mark' }: { n?: number; dot?: number; className?: string }) {
  const pts = useMemo(() => spherePoints(n), [n])
  const first = useMemo(() => markDots(pts, 0, dot), [pts, dot])
  const groupRef = useRef<SVGGElement>(null)

  useEffect(() => {
    const g = groupRef.current
    if (!g) return
    const still = window.matchMedia('(prefers-reduced-motion: reduce)')
    let raf = 0
    let last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (document.hidden || still.matches || now - last < FRAME_MS) return
      last = now
      const dots = markDots(pts, (now / TURN_MS) * Math.PI * 2, dot)
      // the visible count changes as dots cross the edge: rebuild the children
      let html = ''
      for (const d of dots) {
        html += `<circle cx="${d.cx.toFixed(2)}" cy="${d.cy.toFixed(2)}" r="${d.r.toFixed(2)}" fill="${d.fill}" opacity="${d.opacity.toFixed(2)}"/>`
      }
      g.innerHTML = html
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [pts, dot])

  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden focusable="false">
      <g ref={groupRef}>
        {first.map((d, i) => (
          <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={d.fill} opacity={d.opacity} />
        ))}
      </g>
    </svg>
  )
}
