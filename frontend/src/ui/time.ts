// Dates and durations as the pages show them.

export const dateTime = (d: Date | string) =>
  new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export const clockTime = (d: Date | number) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function timeLeft(until: string, now = Date.now()) {
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000))
  if (s < 3600) return `${Math.ceil(s / 60)} min`
  if (s < 86_400) return `${Math.round(s / 3600)} h`
  return `${Math.round(s / 86_400)} days`
}
