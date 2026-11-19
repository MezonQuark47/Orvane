import { useEffect, useState } from 'react'
import type { Contract } from '../../../shared/ledger.ts'
import { useOrvane } from './OrvaneProvider.tsx'

// Active contracts of the given templates, as seen by the current persona.
export function usePolled(templateIds: readonly string[], intervalMs = 1300): Contract<unknown>[] {
  return usePolledState(templateIds, intervalMs).rows
}

// Same, plus whether the first read for this persona has come back yet.
export function usePolledState(templateIds: readonly string[], intervalMs = 1300) {
  const { ledger, party } = useOrvane()
  const [rows, setRows] = useState<Contract<unknown>[]>([])
  const [loadedFor, setLoadedFor] = useState<string>()
  const key = templateIds.join('|')
  useEffect(() => {
    if (!party || !key) return
    setRows([])
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      try {
        const cs = await ledger.query<unknown>(party, key.split('|'))
        if (alive) {
          setRows(cs)
          setLoadedFor(`${party}|${key}`)
        }
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
  return { rows, loaded: !!party && loadedFor === `${party}|${key}` }
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
