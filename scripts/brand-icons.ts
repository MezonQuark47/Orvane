// Writes the favicon (frontend/public/orvane.svg) from the same particle orb
// the header draws (frontend/src/ui/particleMark.ts), so the two never drift.
//
//   node scripts/brand-icons.ts

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { markSvg } from '../frontend/src/ui/particleMark.ts'

const out = fileURLToPath(new URL('../frontend/public/orvane.svg', import.meta.url))
// fewer, larger dots than the header: a tab icon is 16 px
writeFileSync(out, markSvg({ n: 56, dot: 1.9, angle: 0.35, background: '#08090b' }))
console.log('wrote', out)
