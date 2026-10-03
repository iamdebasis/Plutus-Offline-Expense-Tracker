/** Axis ticks for 0..maxValue: about four steps of 1, 2, 2.5 or 5 × a power of ten. */
export function niceScale(maxValue: number) {
  if (maxValue <= 0) return { ticks: [0], max: 1 }
  const rough = maxValue / 4
  const pow = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow
  const top = Math.ceil(maxValue / step) * step
  const ticks = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v)
  return { ticks, max: top }
}
