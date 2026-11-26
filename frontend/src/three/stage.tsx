// The slot a page reserves for the vault. The 3D canvas stays fixed behind
// the app, but the vault fits itself into this box every frame, so it sits in
// the layout and scrolls with the content instead of floating over it.
//
// Kept free of three.js so pages can use it without pulling in the 3D bundle.

import type { ReactNode } from 'react'

export type StageScene = 'hero' | 'trade' | 'markets' | 'how' | 'liquidity' | 'payments' | 'lending' | 'holdings'

interface StageProps {
  scene: StageScene
  /** Orb weights, ~1 at rest. Overrides the pool-driven default. */
  weights?: [number, number]
  /** Vertical offset between the orbs, like a balance (brass up when > 0). */
  lift?: number
  className?: string
  children?: ReactNode
}

export function VaultStage({ scene, weights, lift, className = '', children }: StageProps) {
  return (
    <div
      className={`vault-stage stage-${scene} ${className}`}
      data-vault-stage={scene}
      data-wa={weights?.[0]}
      data-wb={weights?.[1]}
      data-lift={lift}
      aria-hidden
    >
      {children}
    </div>
  )
}
