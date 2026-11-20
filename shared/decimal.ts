// Daml Decimal (Numeric 10) arithmetic on bigints, so quotes computed off
// ledger match what the contract computes to the last digit. Values are
// fixed-point integers scaled by 10^10; multiplication and division round
// half to even, like Daml does.

export type Dec = bigint

const SCALE = 10_000_000_000n
const DIGITS = 10

export const ZERO: Dec = 0n
export const TICK: Dec = 1n

export function dec(value: string | number): Dec {
  const text = typeof value === 'number' ? value.toFixed(DIGITS) : value.trim()
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) throw new Error(`not a decimal: ${value}`)
  const frac = (m[3] ?? '').padEnd(DIGITS, '0')
  if (frac.length > DIGITS && /[1-9]/.test(frac.slice(DIGITS))) throw new Error(`more than ${DIGITS} decimal places: ${value}`)
  const v = BigInt(m[2]) * SCALE + BigInt(frac.slice(0, DIGITS))
  return m[1] ? -v : v
}

// The Ledger API's encoding of a Decimal.
export function show(v: Dec): string {
  const neg = v < 0n
  const abs = neg ? -v : v
  const whole = abs / SCALE
  const frac = (abs % SCALE).toString().padStart(DIGITS, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

export const toNumber = (v: Dec) => Number(show(v))

// n / d rounded half to even.
function roundDiv(n: bigint, d: bigint): bigint {
  if (d < 0n) return roundDiv(-n, -d)
  const q = n / d
  const r = n % d
  const twice = 2n * (r < 0n ? -r : r)
  if (twice < d) return q
  if (twice > d) return n < 0n ? q - 1n : q + 1n
  return q % 2n === 0n ? q : n < 0n ? q - 1n : q + 1n
}

export const mul = (a: Dec, b: Dec): Dec => roundDiv(a * b, SCALE)
export const div = (a: Dec, b: Dec): Dec => {
  if (b === 0n) throw new Error('division by zero')
  return roundDiv(a * SCALE, b)
}
export const fromInt = (n: number | bigint): Dec => BigInt(n) * SCALE
export const min = (a: Dec, b: Dec) => (a < b ? a : b)
export const abs = (a: Dec) => (a < 0n ? -a : a)
export const sum = (xs: Dec[]) => xs.reduce((s, x) => s + x, 0n)
