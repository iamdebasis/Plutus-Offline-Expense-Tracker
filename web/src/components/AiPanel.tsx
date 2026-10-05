import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy, ExternalLink, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AiModel, AiSetup, AiStep } from '../types'

const FIT: Record<AiModel['fit'], { text: string; tone: string }> = {
  suits: { text: 'Suits this Mac', tone: 'bg-emerald-300/10 text-emerald-300 ring-emerald-300/20' },
  heavy: { text: 'Heavy for this Mac', tone: 'bg-amber-200/10 text-amber-200 ring-amber-200/20' },
  too_big: { text: 'Too big for this Mac', tone: 'bg-rose-300/10 text-rose-300 ring-rose-300/20' },
}

/** The local AI: what it does, what suits this Mac, what's downloaded, and the steps to set it up. Plutus never
 *  downloads or installs anything: you run the steps, and it notices by itself (this looks again every few seconds
 *  while open, and as soon as you come back from Terminal). */
export function AiPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [setup, setSetup] = useState<AiSetup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const load = () =>
      api
        .aiSetup()
        .then((s) => {
          if (!alive) return
          setSetup(s)
          setError(null)
        })
        .catch((e: Error) => alive && setError(e.message))
    load()
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), 5000)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', load)
    }
  }, [open, onClose])

  const choose = async (model: string | null) => {
    setSwitching(model ?? 'auto')
    try {
      setSetup(await api.chooseModel(model))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSwitching(null)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-end justify-center p-3 sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-title"
            initial={{ y: 28, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 18, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            className="relative flex max-h-[88dvh] w-full max-w-[580px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-panel/95 text-left shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
              <div className="min-w-0">
                <h2 id="ai-title" className="font-display text-[19px] font-semibold tracking-tight">
                  Local AI
                </h2>
                <p className="mt-0.5 text-sm text-zinc-400">{setup?.headline ?? 'Checking this Mac…'}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
              >
                <X className="size-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-5">
              <p className="text-sm text-zinc-400">
                Optional. A model on this Mac sorts payees no rule knows, reads a statement the rules couldn't prove (its
                figures still have to add up) and reads payment screenshots in layouts Plutus doesn't know. Without it,
                those wait for you; everything else works the same.
              </p>
              {error && <p className="text-sm text-rose-300">{error}</p>}
              {setup && <Body setup={setup} switching={switching} onChoose={choose} />}
            </div>

            <p className="border-t border-white/[0.06] bg-black/20 px-6 py-3 text-xs text-zinc-500">
              Runs only on this Mac. Downloading a model fetches public files from ollama.com; none of your data goes
              with it. Plutus itself never downloads or installs anything.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Body({ setup, switching, onChoose }: { setup: AiSetup; switching: string | null; onChoose: (model: string | null) => void }) {
  const { mac, ollama, suggestion } = setup
  const required = setup.steps.filter((s) => !s.optional)
  const facts = [
    mac.chip,
    `${mac.memoryGb} GB memory`,
    `${mac.freeGb} GB free`,
    mac.macos && `macOS ${mac.macos}`,
    ollama.installed ? `Ollama ${ollama.version ?? '(version unknown)'}` : 'Ollama not installed',
  ].filter(Boolean)

  return (
    <>
      <section aria-label="This Mac">
        <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">This Mac</h3>
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <span key={fact} className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-zinc-300 ring-1 ring-white/[0.08]">
              {fact}
            </span>
          ))}
          {ollama.versionOk === false && (
            <span className="rounded-full bg-amber-200/10 px-2.5 py-1 text-xs text-amber-200 ring-1 ring-amber-200/20">
              needs {ollama.minVersion} or newer
            </span>
          )}
        </p>
        {setup.notes.map((note) => (
          <p key={note} className="mt-2 text-sm text-amber-200/90">
            {note}
          </p>
        ))}
      </section>

      {suggestion && (
        <section aria-label="Suggested for this Mac" className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.08]">
          <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Suggested for this Mac</p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-[15px] text-zinc-100">{suggestion.model}</span>
            <span className="text-sm text-zinc-500">{suggestion.sizeGb} GB download</span>
            <span className="text-sm text-zinc-400">
              ·{' '}
              {setup.inUse === suggestion.model ? (
                <span className="text-emerald-300">in use ✓</span>
              ) : suggestion.downloaded ? (
                'downloaded'
              ) : (
                'not downloaded'
              )}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-zinc-400">{cap(suggestion.why)}.</p>
        </section>
      )}

      {setup.steps.length > 0 && (
        <section aria-label="Steps">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
            {required.length ? 'To set it up, on this Mac' : 'Optional'}
          </h3>
          <ol className="mt-2 space-y-3">
            {setup.steps.map((step) => (
              <StepItem key={step.text} step={step} n={step.optional ? null : required.indexOf(step) + 1} />
            ))}
          </ol>
        </section>
      )}

      {setup.models.length > 0 && (
        <section aria-label="Downloaded on this Mac">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Downloaded on this Mac</h3>
          <ul className="mt-2 divide-y divide-white/[0.05] rounded-2xl ring-1 ring-white/[0.08]">
            {setup.models.map((m) => (
              <li key={m.name} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate font-mono text-[13px] text-zinc-100">{m.name}</span>
                    <span className="text-xs text-zinc-500">{m.sizeGb} GB</span>
                    <span className={`rounded-full px-2 py-px text-[11px] ring-1 ${FIT[m.fit].tone}`}>{FIT[m.fit].text}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{cap(m.note)}</p>
                </div>
                {m.inUse ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-emerald-300">
                    <Check className="size-3.5" /> In use
                  </span>
                ) : (
                  m.usable &&
                  !setup.override && (
                    <button
                      type="button"
                      disabled={switching !== null}
                      onClick={() => onChoose(m.name)}
                      className="shrink-0 rounded-full px-3 py-1 text-xs text-zinc-300 ring-1 ring-white/15 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                    >
                      {switching === m.name ? 'Switching…' : 'Use this'}
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
          {setup.chosen && !setup.override && (
            <p className="mt-2 text-xs text-zinc-500">
              You chose {setup.chosen}.{' '}
              <button
                type="button"
                disabled={switching !== null}
                onClick={() => onChoose(null)}
                className="text-zinc-300 underline decoration-white/30 underline-offset-4 hover:decoration-white disabled:opacity-40"
              >
                Let Plutus pick the best one for this Mac
              </button>
            </p>
          )}
        </section>
      )}
    </>
  )
}

function StepItem({ step, n }: { step: AiStep; n: number | null }) {
  return (
    <li className="flex gap-3">
      <span
        className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
          n ? 'bg-white/[0.08] text-zinc-200' : 'text-zinc-500 ring-1 ring-white/10'
        }`}
        aria-hidden
      >
        {n ?? '+'}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-300">{step.text}</p>
        {step.link && (
          <a
            href={step.link}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-sm text-white underline decoration-white/30 underline-offset-4 hover:decoration-white"
          >
            {step.link.replace(/^https:\/\//, '')} <ExternalLink className="size-3.5" />
          </a>
        )}
        {step.command && <Command text={step.command} />}
      </div>
    </li>
  )
}

/** A command for Terminal, with a copy button. Copying can be refused (the browser's permission): the text is easy to
 *  select by hand, too. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* select it by hand */
    }
  }
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-xl bg-black/40 py-1 pr-1 pl-3 ring-1 ring-white/10">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-100 select-all">{text}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy: ${text}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
      >
        {copied ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
