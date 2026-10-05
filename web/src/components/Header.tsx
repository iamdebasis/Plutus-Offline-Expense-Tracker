import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ShieldCheck, X } from 'lucide-react'
import { api } from '../api'
import { hintText, shouldHint, type Waiting } from '../lib/aiHint'
import { aiPanel, useAiPanelOpen } from '../lib/aiPanel'
import { summarize, type Activity } from '../lib/useImportActivity'
import type { LlmState, LlmStatus } from '../types'
import { AiPanel } from './AiPanel'
import { PlutusLogo } from './brand/PlutusLogo'

export const APP_NAME = 'Plutus'

/** `activity`: the files being read, for the local AI's one-time hint once they're done. */
export function Header({ actions, activity }: { actions?: ReactNode; activity?: Activity }) {
  return (
    <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 pt-6 sm:px-6">
      <div className="flex items-center gap-2.5">
        <PlutusLogo className="size-10 -my-1 drop-shadow-[0_4px_14px_rgb(247_179_45/0.25)]" animated title="" />
        <span className="font-display text-[17px] font-semibold tracking-tight">{APP_NAME}</span>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="hidden items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400 sm:inline-flex"
          title="The server only listens on 127.0.0.1 and makes no outside requests"
        >
          <ShieldCheck className="size-3.5 text-zinc-300" />
          On this Mac only
        </span>
        <AiPill activity={activity} />
        {actions}
      </div>
    </header>
  )
}

const AI_LOOK: Record<LlmState, { text: string; dot: string; pulse?: boolean }> = {
  unavailable: { text: 'not set up', dot: 'bg-zinc-600' }, // optional: grey, never an error
  asleep: { text: 'asleep', dot: 'bg-zinc-500' },
  starting: { text: 'waking up', dot: 'bg-amber-300', pulse: true },
  working: { text: 'working', dot: 'bg-emerald-400', pulse: true },
  awake: { text: 'awake', dot: 'bg-emerald-400' },
  stopping: { text: 'going to sleep', dot: 'bg-zinc-400', pulse: true },
}

/** The model's state, which is what costs memory: asleep whenever it isn't loaded. The Ollama app keeps its own
 *  small server running; that's not the model being awake, and the tooltip says so. A click opens the Local AI panel:
 *  what suits this Mac and the steps to set it up. */
function AiPill({ activity }: { activity?: Activity }) {
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const open = useAiPanelOpen()

  useEffect(() => {
    let alive = true
    const tick = () =>
      api
        .llmStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null))
    tick()
    const timer = setInterval(() => document.visibilityState === 'visible' && tick(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open]) // and again when the panel closes: a model may have been chosen or downloaded meanwhile

  if (!status) return null
  const run: Waiting | null = activity ? summarize(activity.batch) : null
  const answer = (see: boolean) => {
    setStatus({ ...status, hintSeen: true })
    api.aiHintSeen().catch(() => {})
    if (see) aiPanel.open()
  }
  const missingModel = status.state !== 'unavailable' && status.modelInstalled === false
  const look = missingModel ? { text: 'model not downloaded', dot: 'bg-zinc-600' } : AI_LOOK[status.state]
  const optional = 'Optional. Without it, payees no rule recognises wait for you in "Needs your eyes".'
  const title = (() => {
    if (status.state === 'unavailable') return `${optional} Click to see what suits this Mac and how to set it up.`
    if (missingModel) return `${optional} ${status.model} isn't downloaded: click for the steps.`
    if (status.state === 'awake')
      return `${status.model} is in memory${status.sleepsIn !== null ? `, and goes to sleep in ${status.sleepsIn}s unless more work comes` : ''}.`
    if (status.state === 'asleep')
      return status.server === 'ollama'
        ? `${status.model} isn't in memory. The Ollama app keeps its own small server running (the llama in your menu bar); quit it there any time, Plutus starts what it needs.`
        : `${status.model} isn't in memory, and nothing is running. Plutus starts Ollama when a job needs it, and stops it ${status.idleSeconds}s after.`
    return `${status.model} via Ollama, on this Mac.`
  })()

  return (
    <div className="relative">
      <button
        type="button"
        title={title}
        onClick={aiPanel.open}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400 transition hover:border-white/15 hover:bg-white/[0.06] hover:text-zinc-200"
      >
        <span className="relative flex size-2">
          {'pulse' in look && look.pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-70 ${look.dot}`} />}
          <span className={`relative size-2 rounded-full ${look.dot}`} />
        </span>
        <span className="hidden whitespace-nowrap sm:inline">
          Local AI · <span className="text-zinc-300">{look.text}</span>
        </span>
        <span className="whitespace-nowrap sm:hidden">AI</span>
      </button>
      <AnimatePresence>
        {run && shouldHint(run, status) && !open && (
          <motion.div
            key="hint"
            role="status"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="absolute top-full right-0 z-30 mt-2 w-[min(320px,calc(100vw-2rem))] origin-top-right rounded-2xl border border-white/10 bg-panel/95 p-4 text-left shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            <button
              type="button"
              onClick={() => answer(false)}
              aria-label="Not now"
              className="absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-full text-zinc-500 transition hover:bg-white/10 hover:text-zinc-100"
            >
              <X className="size-3.5" />
            </button>
            <p className="pr-5 text-[13px] text-zinc-300">{hintText(run)}</p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => answer(true)}
                className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 hover:bg-zinc-200"
              >
                See how
              </button>
              <button
                type="button"
                onClick={() => answer(false)}
                className="rounded-full px-3.5 py-1.5 text-[13px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
              >
                Not now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AiPanel open={open} onClose={aiPanel.close} />
    </div>
  )
}
