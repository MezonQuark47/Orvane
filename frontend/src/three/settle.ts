// Tiny event bus so any page can make the 3D vault react to a settlement,
// without importing three.js into the main bundle.

export const SETTLED_EVENT = 'orvane:settled'

export function signalSettled(from: 'USDx' | 'CCx' = 'USDx') {
  window.dispatchEvent(new CustomEvent(SETTLED_EVENT, { detail: { from } }))
}
