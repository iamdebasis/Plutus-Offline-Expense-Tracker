import type { UploadRecord } from '../types'
import { isReading } from './useImportActivity'

/** How long reading your files takes, from the server's own times (backend/app/imports.py `_set_status`): a run
 *  starts when its first file joined the queue and ends when its last finished, the local AI's step included. They're
 *  the server's, not the page's, so a reload, a second tab or a re-read at startup all see the same clock. A file whose
 *  times weren't kept (read before Plutus kept them) leaves the run without a clock rather than with a wrong one. */

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

/** The run's start, and its end once every file is read (null while reading); null when it can't be told. */
export function runTime(batch: UploadRecord[]): { start: number; end: number | null } | null {
  if (!batch.length) return null
  const queued = batch.map((u) => ms(u.importStatus?.queuedAt))
  if (queued.some((t) => t === null)) return null
  const start = Math.min(...(queued as number[]))
  if (batch.some(isReading)) return { start, end: null }
  const finished = batch.map((u) => ms(u.importStatus?.finishedAt))
  if (finished.some((t) => t === null)) return null
  return { start, end: Math.max(start, ...(finished as number[])) }
}

/** One file's own reading, from its start to its finish (its wait in the queue left out); null until it's done. */
export function fileTime(u: UploadRecord): number | null {
  const start = ms(u.importStatus?.startedAt)
  const end = ms(u.importStatus?.finishedAt)
  return start === null || end === null ? null : Math.max(0, end - start)
}

const pad = (n: number) => String(n).padStart(2, '0')
const parts = (time: number) => {
  const s = Math.floor(Math.max(0, time) / 1000)
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 }
}

/** The running clock, as a stopwatch shows it: "0:07", "4:12", "1:04:12". */
export function clock(time: number): string {
  const { h, m, s } = parts(time)
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A finished time in a sentence: "under a second", "7s", "4m 12s", "1h 4m". */
export function took(time: number): string {
  if (time < 1000) return 'under a second'
  const { h, m, s } = parts(time)
  if (h) return m ? `${h}h ${m}m` : `${h}h`
  if (m) return s ? `${m}m ${s}s` : `${m}m`
  return `${s}s`
}

/** The clock as a screen reader says it: "4 minutes 12 seconds". */
export function spoken(time: number): string {
  const { h, m, s } = parts(time)
  const say = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  const out = [h && say(h, 'hour'), m && say(m, 'minute'), (s || (!h && !m)) && say(s, 'second')].filter(Boolean)
  return out.join(' ')
}
