import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Check, RotateCcw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { plural, shortPath } from '../lib/format'
import type { ResetPreview } from '../types'

const CONFIRM = 'start over'

/** Start over, at the foot of Your vault: everything Plutus keeps about you goes to the macOS Trash, and Plutus is as a
 *  fresh clone has it. You type the words first, and nothing is erased: until the Trash is emptied it can be put back. */
export function StartOver() {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-white/[0.06] pt-5">
      <div className="min-w-0">
        <p className="text-sm text-zinc-300">Start over</p>
        <p className="text-xs text-zinc-500">Move everything Plutus keeps about you to the Trash, and begin again with an empty Plutus.</p>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] text-rose-300 ring-1 ring-rose-300/30 transition hover:bg-rose-400/10"
      >
        <RotateCcw className="size-3.5" />
        Remove all my data…
      </button>
      <StartOverDialog open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

type Phase = { step: 'ask' } | { step: 'moving' } | { step: 'done'; trash: string | null } | { step: 'failed'; message: string }

function StartOverDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [preview, setPreview] = useState<ResetPreview | null>(null)
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>({ step: 'ask' })
  const moving = phase.step === 'moving'
  const done = phase.step === 'done'

  useEffect(() => {
    if (!open) return
    setTyped('')
    setPhase({ step: 'ask' })
    setPreview(null)
    let alive = true
    api
      .resetPreview()
      .then((p) => alive && setPreview(p))
      .catch((e: Error) => alive && setPhase({ step: 'failed', message: e.message }))
    return () => {
      alive = false
    }
  }, [open])

  // Closing is refused while the move runs, and once it's done there's only "Start fresh": the page must reload.
  const close = () => !moving && !done && onClose()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const confirmed = typed.trim().toLowerCase() === CONFIRM
  const go = async () => {
    if (!confirmed || moving || !preview || preview.busy) return
    setPhase({ step: 'moving' })
    try {
      const res = await api.startOver(typed)
      setPhase({ step: 'done', trash: res.trash })
    } catch (e) {
      setPhase({ step: 'failed', message: (e as Error).message })
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="start-over-title"
            initial={{ y: 28, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 18, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            className="relative flex max-h-[88dvh] w-full max-w-[520px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-panel/95 text-left shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-2">
              <div className="min-w-0">
                <h2 id="start-over-title" className="font-display text-[19px] font-semibold tracking-tight">
                  {done ? 'Plutus is empty again' : 'Start over'}
                </h2>
                <p className="mt-0.5 text-sm text-zinc-400">
                  {done ? 'Everything it kept about you is in the Trash.' : 'Everything Plutus keeps about you goes to the Trash, and Plutus begins again as new.'}
                </p>
              </div>
              {!done && (
                <button
                  type="button"
                  onClick={close}
                  disabled={moving}
                  aria-label="Close"
                  className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30"
                >
                  <X className="size-5" />
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5 text-sm">
              {done ? (
                <Done trash={phase.trash} folder={preview?.folder ?? ''} />
              ) : !preview ? (
                phase.step === 'failed' ? <p className="text-rose-300">{phase.message}</p> : <p className="text-zinc-500">Counting what you have…</p>
              ) : (
                <>
                  <What preview={preview} />
                  <p className="text-zinc-400">
                    <span className="text-zinc-300">Nothing is erased.</span> It all goes to the Trash as one folder. Until you
                    empty the Trash, you can get it back: quit Plutus, then move that folder's contents back into{' '}
                    <span className="font-mono text-[13px] text-zinc-300" title={preview.folder}>
                      {shortPath(preview.folder, 40)}
                    </span>
                    .
                  </p>
                  {preview.busy && (
                    <p className="flex items-start gap-2 rounded-xl bg-amber-400/[0.07] px-3 py-2 text-amber-100/90 ring-1 ring-amber-300/15">
                      <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                      {preview.busy}
                    </p>
                  )}
                  {phase.step === 'failed' && <p className="text-rose-300">{phase.message}</p>}
                  <label className="block">
                    <span className="text-zinc-400">
                      To confirm, type <span className="font-mono text-zinc-200">{CONFIRM}</span>
                    </span>
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && go()}
                      disabled={moving || !!preview.busy}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      className="mt-1.5 w-full rounded-xl bg-black/40 px-3 py-2 font-mono text-[14px] text-zinc-100 ring-1 ring-white/10 outline-none placeholder:text-zinc-600 focus:ring-rose-300/40 disabled:opacity-50"
                      placeholder={CONFIRM}
                    />
                  </label>
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] bg-black/20 px-6 py-3">
              {done ? (
                <button
                  type="button"
                  onClick={startFresh}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200"
                >
                  Start fresh
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={close}
                    disabled={moving}
                    className="rounded-full px-3.5 py-1.5 text-[13px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-40"
                  >
                    Keep my data
                  </button>
                  <button
                    type="button"
                    onClick={go}
                    disabled={!confirmed || moving || !preview || !!preview.busy}
                    className="inline-flex items-center gap-1.5 rounded-full bg-rose-500 px-4 py-1.5 text-[13px] font-semibold text-white transition hover:bg-rose-400 disabled:cursor-not-allowed disabled:bg-rose-500/25 disabled:text-white/50"
                  >
                    {moving && <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
                    {moving ? 'Moving to the Trash…' : 'Remove everything'}
                  </button>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function What({ preview: p }: { preview: ResetPreview }) {
  const answers = [
    p.answers && plural(p.answers, 'category you set', 'categories you set'),
    p.payees && plural(p.payees, 'payee you named', 'payees you named'),
    p.accounts && plural(p.accounts, 'own account'),
  ].filter(Boolean)
  const lines = [
    `${plural(p.transactions, 'transaction')}, from ${plural(p.files, 'file')} you added (the files themselves too)`,
    `${plural(p.statements, 'card statement')} and ${plural(p.cards, 'card')}`,
    answers.length ? `Your answers: ${answers.join(', ')}` : null,
    `Your settings${p.cardPictures ? `, ${plural(p.cardPictures, 'card picture')}` : ''} and the local AI's saved answers`,
  ].filter(Boolean)
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-2xl bg-rose-400/[0.05] p-3.5 ring-1 ring-rose-300/15">
        <p className="text-xs font-medium tracking-wide text-rose-200/80 uppercase">Goes to the Trash</p>
        <ul className="mt-1.5 space-y-1 text-zinc-300">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
      <div className="rounded-2xl bg-white/[0.03] p-3.5 ring-1 ring-white/[0.08]">
        <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Stays</p>
        <ul className="mt-1.5 space-y-1 text-zinc-400">
          <li>Plutus itself</li>
          <li>Ollama and its models</li>
          <li>The demo</li>
        </ul>
      </div>
    </div>
  )
}

function Done({ trash, folder }: { trash: string | null; folder: string }) {
  const name = trash ? trash.split('/').pop() : null
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-zinc-200">
        <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" strokeWidth={2.6} />
        {name ? (
          <span>
            In the Trash as <span className="text-zinc-100">“{name}”</span>.
          </span>
        ) : (
          <span>There was nothing to move: Plutus was already empty.</span>
        )}
      </p>
      {name && (
        <p className="text-zinc-400">
          To get it back before you empty the Trash: quit Plutus, then move that folder's contents back into{' '}
          <span className="font-mono text-[13px] text-zinc-300" title={folder}>
            {shortPath(folder, 40)}
          </span>
          .
        </p>
      )}
    </div>
  )
}

/** The page starts again from nothing: it forgets how its panels were left (collapsed sections, ticked chart lines), as a
 *  fresh clone's page would, and loads again. */
function startFresh() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('plutus.')) localStorage.removeItem(key)
  } catch {
    /* the browser keeps nothing for this page, then */
  }
  window.location.reload()
}
