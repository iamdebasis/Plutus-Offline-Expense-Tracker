// Text the page shows can be read: every grey a word is set in reaches WCAG's 4.5:1 against every surface it sits on,
// worked out from the colours in index.css (no browser needed). The faint grey is for decoration only.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const SRC = join(import.meta.dirname, '..', 'src')
const css = readFileSync(join(SRC, 'index.css'), 'utf8')

/** A colour token's hex value as index.css first sets it (the default look, before any media query). */
function token(name: string): number[] {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  assert.ok(m, `index.css sets --color-${name} as a hex colour`)
  return [1, 3, 5].map((i) => parseInt(m[1].slice(i, i + 2), 16))
}
/** The same token under `@media (prefers-contrast: more)`. */
function moreContrast(name: string): number[] {
  const block = css.slice(css.indexOf('@media (prefers-contrast: more)'))
  const m = block.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  assert.ok(m, `index.css sets --color-${name} for prefers-contrast: more`)
  return [1, 3, 5].map((i) => parseInt(m[1].slice(i, i + 2), 16))
}

const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const over = (fg: number[], alpha: number, bg: number[]) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))
const WHITE = [255, 255, 255]

// Every surface text sits on, as the page lays them: the page, a card on it (90% opaque, Section.tsx), the raised
// fills on a card (a ticked row, a select, a chip: white at 4% to 8%), a panel, and the ticked-payments bar (zinc-900).
const surfaces = () => {
  const canvas = token('canvas')
  const card = over(token('card'), 0.9, canvas)
  return {
    page: canvas,
    card,
    'raised 4%': over(WHITE, 0.04, card),
    'raised 8%': over(WHITE, 0.08, card),
    panel: token('panel'),
    bar: over([24, 24, 27], 0.95, card),
  }
}

test('helper text reads at 4.5:1 or more on every surface, and stays quieter than labels', () => {
  for (const [where, bg] of Object.entries(surfaces())) {
    const k = contrast(token('muted'), bg)
    assert.ok(k >= 4.5, `muted text on the ${where}: ${k.toFixed(2)}:1`)
  }
  // zinc-400, the labels' grey, stays the brighter of the two, so the hierarchy holds
  assert.ok(luminance(token('muted')) < luminance([159, 159, 169]))
})

test('the faint grey is for decoration: dimmer than helper text, yet visible on the page and its cards', () => {
  const { page, card } = surfaces()
  assert.ok(luminance(token('faint')) < luminance(token('muted')))
  for (const bg of [page, card]) assert.ok(contrast(token('faint'), bg) >= 3, `faint: ${contrast(token('faint'), bg).toFixed(2)}:1`)
})

test('with Increase contrast on, both step up and helper text reaches 7:1', () => {
  for (const name of ['muted', 'faint']) assert.ok(luminance(moreContrast(name)) > luminance(token(name)), `${name} is brighter`)
  for (const [where, bg] of Object.entries(surfaces())) {
    const k = contrast(moreContrast('muted'), bg)
    assert.ok(k >= 7, `muted text on the ${where}, more contrast: ${k.toFixed(2)}:1`)
  }
})

test("no text is set in the greys that don't reach it: zinc-500, 600 and 700 (use muted, or faint for decoration)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []))
  const found = files(SRC).flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(/(?:[\w-]+:)*(?:text|fill|placeholder:text)-zinc-(?:500|600|700)\b/g)].map((m) => `${f.slice(SRC.length + 1)}:${i + 1} ${m[0]}`)),
  )
  assert.deepEqual(found, [])
})

test('with Increase contrast on, every faint white edge the page draws is made stronger, and a control\'s edge reaches 3:1', () => {
  const block = css.slice(css.indexOf('@media (prefers-contrast: more)'))
  const covered = new Set([...block.matchAll(/\[class~="((?:border|ring|divide)-white\/[^"]+)"\]/g)].map((m) => m[1]))
  const alpha = (v: string) => (v.startsWith('[') ? Number(v.slice(1, -1)) : Number(v) / 100)
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []))
  const used = new Set(
    files(SRC).flatMap((f) =>
      // a base class (not hover: or focus:), on any side: border-t-white/… draws the same edge as border-white/…
      [...readFileSync(f, 'utf8').matchAll(/(?<![\w:-])(border|ring|divide)(?:-[trblxy])?-white\/(\[0\.\d+\]|\d+)/g)]
        .filter((m) => alpha(m[2]) < 0.2)
        .map((m) => `${m[1]}-white/${m[2]}`),
    ),
  )
  assert.ok(used.size > 0)
  assert.deepEqual([...used].filter((c) => !covered.has(c)), [], 'add these to the prefers-contrast block in index.css')
  const card = over(token('card'), 0.9, token('canvas'))
  assert.ok(contrast(over(WHITE, 0.4, card), card) >= 3)
})
