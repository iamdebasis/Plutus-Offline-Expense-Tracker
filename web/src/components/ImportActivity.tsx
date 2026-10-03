import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, ArrowDown, Check, Clock3, MinusCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { plural } from '../lib/format'
import { summarize, type Activity } from '../lib/useImportActivity'
import type { UploadRecord } from '../types'

interface Props {
  activity: Activity
  /** Files still being sent from this page. */
  pending?: number
  /** Where "Review" takes you; hidden when there's nowhere to go. */
  onReview?: () => void
}

/** Background reading at a glance: "Reading 2 of 5" with a ring while it runs, a summary once it's
 *  done (kept until dismissed, so you know it finished). Click for each file's progress. */
export function ImportActivity({ activity, pending = 0, onReview }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const s = summarize(activity.batch, pending)
  const visible = s.total > 0 && (s.reading || !activity.dismissed)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(() => {
    if (!visible) setOpen(false)
  }, [visible])

  const trouble = s.failed.length + s.skipped.length
  const fraction = s.total ? (s.finished + (s.current?.importStatus?.state === 'running' ? 0.5 : 0)) / s.total : 0

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={root}
          key="activity"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          className="relative"
        >
          <div
            className={`flex items-center rounded-full ring-1 transition-colors ${
              s.reading ? 'bg-amber-200/[0.06] ring-amber-200/20' : trouble ? 'bg-rose-300/[0.06] ring-rose-300/20' : 'bg-emerald-300/[0.06] ring-emerald-300/20'
            }`}
          >
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-haspopup="dialog"
              className="flex min-w-0 items-center gap-2 py-1.5 pr-3 pl-2 text-[13px]"
            >
              {s.reading ? (
                <Ring fraction={fraction} />
              ) : trouble ? (
                <AlertCircle className="size-4 shrink-0 text-rose-300" />
              ) : (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
                  <Check className="size-4 shrink-0 rounded-full bg-emerald-400 p-0.5 text-emerald-950" strokeWidth={3.5} />
                </motion.span>
              )}
              <span role="status" className="min-w-0 truncate text-zinc-200 tabular-nums">
                {s.reading ? (
                  <>
                    <span className="sm:hidden">
                      {s.finished}/{s.total}
                    </span>
                    <span className="hidden sm:inline">
                      Reading {Math.min(s.finished + 1, s.total)} of {plural(s.total, 'file')}
                    </span>
                    {s.current && <span className="hidden text-zinc-500 lg:inline"> · {s.current.importStatus?.step ?? 'Waiting its turn'}</span>}
                  </>
                ) : (
                  doneText(s)
                )}
              </span>
            </button>
            {!s.reading && (
              <button
                type="button"
                onClick={activity.dismiss}
                aria-label="Dismiss"
                className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-100"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <AnimatePresence>
            {open && (
              <motion.div
                role="dialog"
                aria-label="Files being read"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.16 }}
                className="absolute top-full right-0 z-30 mt-2 w-[min(380px,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-2xl border border-white/10 bg-panel/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
              >
                <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] px-4 pt-3.5 pb-3">
                  <p className="font-display text-[15px] font-semibold tracking-tight">{s.reading ? 'Reading your files' : 'Finished reading'}</p>
                  <p className="text-xs text-zinc-500 tabular-nums">
                    {s.finished} of {s.total} done
                  </p>
                </div>
                <ul className="max-h-[min(360px,60dvh)] overflow-y-auto px-2 py-1.5">
                  {pending > 0 && (
                    <li className="flex items-center gap-3 rounded-xl px-2 py-2">
                      <Spinner />
                      <p className="text-[13px] text-zinc-300">Sending {plural(pending, 'file')} to the local server…</p>
                    </li>
                  )}
                  {activity.batch.map((u) => (
                    <FileLine key={u.id} upload={u} />
                  ))}
                </ul>
                {!s.reading && (
                  <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-black/20 px-3 py-2.5">
                    {onReview && s.toReview > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false)
                          onReview()
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 hover:bg-zinc-200"
                      >
                        Review {s.toReview} <ArrowDown className="size-3.5" />
                      </button>
                    )}
                    <button type="button" onClick={activity.dismiss} className="rounded-full px-3.5 py-1.5 text-[13px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
                      Dismiss
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** A hairline under the sticky bar: fills as files finish, shimmers while one is being read. */
export function ActivityLine({ activity, pending = 0 }: { activity: Activity; pending?: number }) {
  const s = summarize(activity.batch, pending)
  const fraction = s.total ? (s.finished + (s.current?.importStatus?.state === 'running' ? 0.5 : 0)) / s.total : 0
  return (
    <AnimatePresence>
      {s.reading && (
        <motion.div
          key="line"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { delay: 0.4 } }}
          className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] overflow-hidden bg-white/[0.04]"
          aria-hidden
        >
          <motion.div
            className="relative h-full overflow-hidden bg-gradient-to-r from-amber-200/70 to-amber-300"
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(4, fraction * 100)}%` }}
            transition={{ ease: 'easeOut', duration: 0.6 }}
          >
            <span className="absolute inset-0 animate-[plutus-sweep_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/80 to-transparent" />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function doneText(s: ReturnType<typeof summarize>) {
  const parts = [`${plural(s.finished, 'file')} read`, s.added ? `${s.added} new` : 'nothing new']
  if (s.toReview) parts.push(`${s.toReview} to review`)
  if (s.failed.length) parts.push(`${s.failed.length} failed`)
  else if (s.skipped.length) parts.push(`${s.skipped.length} not readable yet`)
  return parts.join(' · ')
}

function FileLine({ upload }: { upload: UploadRecord }) {
  const st = upload.importStatus
  const state = st?.state ?? 'queued'
  const icon =
    state === 'running' ? (
      <Spinner />
    ) : state === 'queued' ? (
      <Clock3 className="size-4 text-zinc-500" />
    ) : state === 'done' ? (
      <Check className="size-4 text-emerald-300" strokeWidth={2.6} />
    ) : state === 'failed' ? (
      <AlertCircle className="size-4 text-rose-300" />
    ) : (
      <MinusCircle className="size-4 text-amber-300" />
    )

  let detail: string
  if (state === 'running') detail = `${st?.step ?? 'Reading'}…`
  else if (state === 'queued') detail = 'Waiting its turn'
  else if (state === 'done') {
    const bits = [st?.added ? `${st.added} new` : 'nothing new']
    if (st?.duplicates) bits.push(`${st.duplicates} already known`)
    if (st?.needsReview) bits.push(`${plural(st.needsReview, 'payee')} to review`)
    detail = bits.join(' · ')
  } else detail = st?.error ?? "Couldn't read it"

  return (
    <li className="flex items-start gap-3 rounded-xl px-2 py-2">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-zinc-100" title={upload.originalName}>
          {upload.originalName}
        </p>
        <p className={`text-xs leading-snug ${state === 'failed' ? 'text-rose-300' : state === 'skipped' ? 'text-amber-300/90' : 'text-zinc-500'}`}>
          <span className="text-zinc-400">{upload.detection.label}</span> · {detail}
        </p>
      </div>
    </li>
  )
}

function Ring({ fraction }: { fraction: number }) {
  const r = 6.5
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0 -rotate-90" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-white/10" />
      <motion.circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-amber-300"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: c * (1 - Math.max(0.08, fraction)) }}
        transition={{ ease: 'easeOut', duration: 0.6 }}
      />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${c * 0.12} ${c}`} className="origin-center animate-spin text-amber-100/70 [animation-duration:1.1s]" />
    </svg>
  )
}

function Spinner() {
  return <span className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-white/20 border-t-amber-200" />
}
