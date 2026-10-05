import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { UploadRecord } from '../types'

const FINAL = new Set(['done', 'failed', 'skipped'])
export const isReading = (u: UploadRecord) => !!u.importStatus && !FINAL.has(u.importStatus.state)

export interface Activity {
  /** Every stored file, as of the last check. */
  uploads: UploadRecord[] | null
  /** The files in the current run (or the last one, until dismissed), in the order they arrived. */
  batch: UploadRecord[]
  dismissed: boolean
  dismiss: () => void
  /** Follow these just-uploaded files, and check on them right away. */
  track: (records: UploadRecord[]) => void
}

/** What the server is reading in the background, for the whole app. One poller: every second while
 *  something is being read, every few seconds otherwise (a restart can re-read files by itself).
 *  `onSettled` fires when a file's transactions are saved (before the local AI, which can take minutes
 *  on an all-time statement) and again when it finishes, so the dashboard fills in as early as it can. */
export function useImportActivity(onSettled: () => void): Activity {
  const [uploads, setUploads] = useState<UploadRecord[] | null>(null)
  const [batch, setBatch] = useState<UploadRecord[]>([])
  const [dismissed, setDismissed] = useState(false)

  const ids = useRef<string[]>([])
  const addedAt = useRef(new Map<string, number>())
  const settled = useRef(new Set<string>())
  const saved = useRef(new Map<string, number>())
  const records = useRef(new Map<string, UploadRecord>())
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled
  const wake = useRef<() => void>(() => {})

  /** Adds files to the run; if the last run had finished, this starts a new one. */
  const join = useCallback((fresh: UploadRecord[]) => {
    const add = fresh.filter((u) => !ids.current.includes(u.id))
    if (!add.length) return false
    if (ids.current.every((id) => settled.current.has(id))) ids.current = []
    const now = Date.now()
    for (const u of add) {
      ids.current.push(u.id)
      addedAt.current.set(u.id, now)
      settled.current.delete(u.id)
      records.current.set(u.id, u)
    }
    setDismissed(false)
    return true
  }, [])

  const publish = useCallback(() => {
    setBatch(ids.current.map((id) => records.current.get(id)).filter((u): u is UploadRecord => !!u))
  }, [])

  const track = useCallback(
    (fresh: UploadRecord[]) => {
      if (join(fresh.filter((u) => !u.duplicate && u.importStatus))) {
        publish()
        wake.current()
      }
    },
    [join, publish],
  )

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    let inflight = false
    let again = false

    const poll = async () => {
      if (inflight) {
        again = true
        return
      }
      inflight = true
      window.clearTimeout(timer)
      const startedAt = Date.now()
      try {
        const list = await api.uploads()
        if (!alive) return
        const byId = new Map(list.map((u) => [u.id, u]))
        // a file tracked after this request left may not be in the answer yet; keep it
        for (const [id, u] of records.current) if (!byId.has(id) && (addedAt.current.get(id) ?? 0) >= startedAt) byId.set(id, u)
        records.current = byId
        join(list.filter(isReading).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt)))
        ids.current = ids.current.filter((id) => byId.has(id)) // deleted meanwhile

        let finished = false
        for (const id of ids.current) {
          const u = byId.get(id)!
          if (!isReading(u) && !settled.current.has(id)) {
            settled.current.add(id)
            finished = true
          }
          const added = u.importStatus?.added ?? 0
          if (added > (saved.current.get(id) ?? 0)) {
            saved.current.set(id, added)
            finished ||= isReading(u) // its transactions are in the ledger; categories may still change
          }
        }
        setUploads(list)
        publish()
        if (finished) onSettledRef.current()
      } catch {
        /* the server may be restarting; try again shortly */
      } finally {
        inflight = false
        if (alive) {
          const busy = ids.current.some((id) => !settled.current.has(id))
          timer = window.setTimeout(poll, again ? 0 : busy ? 1000 : document.hidden ? 15000 : 5000)
          again = false
        }
      }
    }

    wake.current = () => void poll()
    const onVisible = () => !document.hidden && poll()
    document.addEventListener('visibilitychange', onVisible)
    poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
      wake.current = () => {}
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [join, publish])

  const dismiss = useCallback(() => setDismissed(true), [])
  return { uploads, batch, dismissed, dismiss, track }
}

/** The numbers the progress indicator shows. `pending` counts files still on their way to the server. */
export function summarize(batch: UploadRecord[], pending = 0) {
  const done = batch.filter((u) => !isReading(u))
  const current = batch.find((u) => u.importStatus?.state === 'running') ?? batch.find(isReading)
  const sum = (key: 'added' | 'needsReview' | 'duplicates') => done.reduce((n, u) => n + (u.importStatus?.[key] ?? 0), 0)
  return {
    total: batch.length + pending,
    finished: done.length,
    reading: pending > 0 || done.length < batch.length,
    current,
    added: sum('added'),
    known: sum('duplicates'),
    toReview: sum('needsReview'),
    /** files read but held: statements whose rows wait in Your vault, uncounted */
    onHold: done.filter((u) => (u.importStatus?.held ?? 0) > 0).length,
    failed: done.filter((u) => u.importStatus?.state === 'failed'),
    skipped: done.filter((u) => u.importStatus?.state === 'skipped'),
  }
}
