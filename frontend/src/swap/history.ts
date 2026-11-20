// Your swaps, kept in this browser only (per network and wallet), the way a
// wallet keeps its own list. Orvane has no server that sees them.

import type { Amount } from '../../../shared/cantex.ts'
import { NETWORK } from '../ledger/network.ts'

export interface SwapRecord {
  id: string
  at: number
  sell: Amount
  quoted: Amount
  received?: string
  status: 'sending' | 'filled' | 'pending' | 'failed'
}

const KEEP = 100
const key = (party: string) => `orvane.swaps.${NETWORK.id}.${party}`
const listeners = new Set<() => void>()

export function loadSwaps(party: string): SwapRecord[] {
  try {
    return JSON.parse(localStorage.getItem(key(party)) ?? '[]') as SwapRecord[]
  } catch {
    return []
  }
}

function save(party: string, records: SwapRecord[]) {
  try {
    localStorage.setItem(key(party), JSON.stringify(records.slice(0, KEEP)))
  } catch {
    /* storage blocked or full: history lives for this page only */
  }
  listeners.forEach((l) => l())
}

export function recordSwap(party: string, r: Omit<SwapRecord, 'id' | 'status'>): string {
  const id = `${r.at.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  save(party, [{ ...r, id, status: 'sending' }, ...loadSwaps(party)])
  return id
}

export function updateSwap(party: string, id: string, patch: Partial<SwapRecord>) {
  save(
    party,
    loadSwaps(party).map((r) => (r.id === id ? { ...r, ...patch } : r)),
  )
}

export function onSwapsChanged(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
