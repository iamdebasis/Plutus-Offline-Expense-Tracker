import { useEffect, useState, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { api } from '../api'
import type { LlmState, LlmStatus } from '../types'
import { PlutusLogo } from './brand/PlutusLogo'

export const APP_NAME = 'Plutus'

export function Header({ actions }: { actions?: ReactNode }) {
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
        <AiPill />
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
 *  small server running; that's not the model being awake, and the tooltip says so. */
function AiPill() {
  const [status, setStatus] = useState<LlmStatus | null>(null)

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
  }, [])

  if (!status) return null
  const missingModel = status.state !== 'unavailable' && status.modelInstalled === false
  const look = missingModel ? { text: 'model not downloaded', dot: 'bg-zinc-600' } : AI_LOOK[status.state]
  const optional = 'Optional. Without it, payees no rule recognises wait for you in "Needs your eyes".'
  const title = (() => {
    if (status.state === 'unavailable') return `${optional} To have them sorted on this Mac, install Ollama (ollama.com), then run: ollama pull ${status.model}`
    if (missingModel) return `${optional} Ollama is installed; to use it, run: ollama pull ${status.model}`
    if (status.state === 'awake')
      return `${status.model} is in memory${status.sleepsIn !== null ? `, and goes to sleep in ${status.sleepsIn}s unless more work comes` : ''}.`
    if (status.state === 'asleep')
      return status.server === 'ollama'
        ? `${status.model} isn't in memory. The Ollama app keeps its own small server running (the llama in your menu bar); quit it there any time, Plutus starts what it needs.`
        : `${status.model} isn't in memory, and nothing is running. Plutus starts Ollama when a job needs it, and stops it ${status.idleSeconds}s after.`
    return `${status.model} via Ollama, on this Mac.`
  })()

  return (
    <span
      title={title}
      className="inline-flex items-center gap-2 rounded-full border border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-400"
    >
      <span className="relative flex size-2">
        {'pulse' in look && look.pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-70 ${look.dot}`} />}
        <span className={`relative size-2 rounded-full ${look.dot}`} />
      </span>
      <span className="hidden whitespace-nowrap sm:inline">
        Local AI · <span className="text-zinc-300">{look.text}</span>
      </span>
      <span className="whitespace-nowrap sm:hidden">AI</span>
    </span>
  )
}
