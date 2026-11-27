// The Orvane mark: a small dot-matrix sphere, like the particle cloud on the
// landing. Each dot keeps its token colour (ice blue for CC on one half, ember
// on the other), so as the sphere turns the two sides trade places: a swap.
//
// Plain TypeScript with no DOM, so the header component and the script that
// writes the favicon (scripts/brand-icons.ts) draw the same sphere.

export const MARK_CC = '#7fa8ff'
export const MARK_USD = '#ff7a3d'

export interface SpherePoint {
  x: number
  y: number
  z: number
  /** true for the CC half, decided once so the colour turns with the dot */
  cc: boolean
}

export interface MarkDot {
  cx: number
  cy: number
  r: number
  opacity: number
  fill: string
}

/** n points spread evenly over a unit sphere (Fibonacci lattice). */
export function spherePoints(n: number): SpherePoint[] {
  const pts: SpherePoint[] = []
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const t = i * 2.39996
    const x = Math.cos(t) * r
    pts.push({ x, y, z: Math.sin(t) * r, cc: x < 0 })
  }
  return pts
}

/**
 * The visible dots of the sphere turned by `angle` (radians, around the
 * vertical axis), in a 48x48 box. `dot` scales the dots: small renderings
 * use fewer, larger dots so they stay crisp.
 */
export function markDots(pts: SpherePoint[], angle: number, dot = 1): MarkDot[] {
  const s = Math.sin(angle)
  const c = Math.cos(angle)
  const R = 18
  const out: MarkDot[] = []
  for (const p of pts) {
    const x = c * p.x + s * p.z
    const z = -s * p.x + c * p.z
    if (z < -0.15) continue
    out.push({
      cx: 24 + x * R,
      cy: 24 + p.y * R,
      r: (0.55 + z * 0.75) * dot,
      opacity: 0.45 + z * 0.55,
      fill: p.cc ? MARK_CC : MARK_USD,
    })
  }
  // back to front, so nearer dots draw over farther ones
  return out.sort((a, b) => a.r - b.r)
}

/** The mark as standalone SVG markup (for the favicon). */
export function markSvg(opts: { n: number; dot: number; angle?: number; background?: string }): string {
  const dots = markDots(spherePoints(opts.n), opts.angle ?? 0, opts.dot)
    .map((d) => `<circle cx="${d.cx.toFixed(2)}" cy="${d.cy.toFixed(2)}" r="${d.r.toFixed(2)}" fill="${d.fill}" opacity="${d.opacity.toFixed(2)}"/>`)
    .join('')
  const bg = opts.background ? `<rect width="48" height="48" rx="11" fill="${opts.background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${bg}${dots}</svg>\n`
}
