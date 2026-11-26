// The page's own small physics, on top of the particle cloud:
//
//  - a cursor ring that trails the pointer and opens up over anything you
//    can click
//  - magnetic buttons that lean towards the cursor
//  - a spotlight that follows the cursor across glass panels
//
// Pointer-only (fine pointers); one rAF loop; returns a cleanup.

const MAGNETS = '.ex-btn, .primary, .wallet-connect, .flip'
const CLICKABLE = 'button, a, [role="button"], input, select, label'
const GLASS = '.panel, .ex-card'

export function startKinetic(): () => void {
  if (!window.matchMedia('(pointer: fine)').matches) return () => {}

  const pointer = { x: -9999, y: -9999, on: false }
  const ring = document.createElement('div')
  ring.className = 'cursor-ring'
  ring.setAttribute('aria-hidden', 'true')
  document.body.appendChild(ring)
  let rx = -100,
    ry = -100,
    hot = 0,
    press = 0

  let magnet: HTMLElement | null = null
  let lit: HTMLElement | null = null
  const onMove = (e: PointerEvent) => {
    pointer.x = e.clientX
    pointer.y = e.clientY
    pointer.on = true
    const target = e.target as Element | null
    hot = target?.closest(CLICKABLE) ? 1 : 0

    const m = target?.closest<HTMLElement>(MAGNETS) ?? null
    if (magnet && magnet !== m) magnet.style.translate = ''
    magnet = m
    if (m && !(m as HTMLButtonElement).disabled) {
      const r = m.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      m.style.translate = `${dx * 0.18}px ${dy * 0.28}px`
    }

    const g = target?.closest<HTMLElement>(GLASS) ?? null
    if (lit && lit !== g) lit.classList.remove('lit')
    lit = g
    if (g) {
      const r = g.getBoundingClientRect()
      g.style.setProperty('--spot-x', `${e.clientX - r.left}px`)
      g.style.setProperty('--spot-y', `${e.clientY - r.top}px`)
      g.classList.add('lit')
    }
  }
  const onLeave = () => {
    pointer.on = false
    if (magnet) magnet.style.translate = ''
    magnet = null
  }
  const onDown = () => (press = 1)
  window.addEventListener('pointermove', onMove, { passive: true })
  document.documentElement.addEventListener('pointerleave', onLeave)
  window.addEventListener('pointerdown', onDown)

  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    if (document.hidden) return
    rx += (pointer.x - rx) * 0.2
    ry += (pointer.y - ry) * 0.2
    press *= 0.88
    const scale = (1 + hot * 0.75) * (1 - press * 0.25)
    ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`
    ring.style.opacity = pointer.on ? '1' : '0'
    ring.classList.toggle('hot', hot > 0)
  }
  raf = requestAnimationFrame(frame)

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', onMove)
    document.documentElement.removeEventListener('pointerleave', onLeave)
    window.removeEventListener('pointerdown', onDown)
    ring.remove()
  }
}
