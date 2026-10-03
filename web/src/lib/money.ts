const full = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const whole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const paise = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** ₹1,23,456 */
export const inr = (n: number) => full.format(Math.round(n))
/** ₹1,174.50, ₹980 — for individual transactions: paise when there are any, always two digits of them */
export const inrExact = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 ? whole.format(Math.round(n)) : paise.format(n))

/** ₹8.9L, ₹12K, ₹1.2Cr — Indian compact units for axes and tight spaces */
export function inrCompact(n: number): string {
  const abs = Math.abs(n)
  const fmt = (v: number, unit: string) => `₹${v >= 100 ? Math.round(v) : +v.toFixed(1)}${unit}`
  if (abs >= 1e7) return fmt(n / 1e7, 'Cr')
  if (abs >= 1e5) return fmt(n / 1e5, 'L')
  if (abs >= 1e3) return fmt(n / 1e3, 'K')
  return `₹${Math.round(n)}`
}
