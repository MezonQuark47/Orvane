import { useEffect, useState } from 'react'
import type { Contract } from '../../../shared/ledger.ts'
import { useOrvane } from './OrvaneProvider.tsx'

// Active contracts of the given templates, as seen by the current persona.
export function usePolled(templateIds: readonly string[], intervalMs = 1300): Contract<unknown>[] {
  const { ledger, party } = useOrvane()
  const [rows, setRows] = useState<Contract<unknown>[]>([])
  const key = templateIds.join('|')
  useEffect(() => {
    if (!party) return
    setRows([])
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const cs = await ledger.query<unknown>(party, key.split('|'))
        if (alive) setRows(cs)
      } catch {
        /* keep last */
      }
      if (alive) timer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [ledger, party, key, intervalMs])
  return rows
}

export const pick = <T,>(rows: Contract<unknown>[], entity: string) =>
  rows.filter((c) => c.templateId.endsWith(`:${entity}`)) as Contract<T>[]

// Re-render every `ms` (for live-accruing numbers).
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
