// Smooth scrolling for the whole site (Lenis). Off for people who ask for
// reduced motion; then the browser scrolls as usual.

import Lenis from 'lenis'

let lenis: Lenis | undefined

export function startSmoothScroll() {
  if (lenis || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  lenis = new Lenis({ lerp: 0.09 })
  const raf = (t: number) => {
    lenis?.raf(t)
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
}

/** Scroll to an element or a position, smoothly when Lenis runs. */
export function scrollToTarget(target: HTMLElement | number, immediate = false) {
  if (lenis) lenis.scrollTo(target, { immediate })
  else if (typeof target === 'number') window.scrollTo({ top: target, behavior: immediate ? 'auto' : 'smooth' })
  else target.scrollIntoView({ behavior: immediate ? 'auto' : 'smooth' })
}
