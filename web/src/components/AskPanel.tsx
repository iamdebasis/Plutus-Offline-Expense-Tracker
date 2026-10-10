import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, ChevronDown, Info, ListFilter, RotateCcw, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import { answer, emptyQuery, periodBefore, rangePeriod, showLabel, suggestions, yearPeriod, type AskAnswer, type AskLine, type AskPeriod, type AskQuery } from '../lib/ask'
import { couldBePayee, readQuestion, type AskContext } from '../lib/askRules'
import { aiPanel } from '../lib/aiPanel'
import { periodsIn, type LedgerData } from '../lib/ledger'
import { inr, inrExact } from '../lib/money'
import { monthLabel } from '../lib/periods'
import type { AiQuery } from '../types'
import { AskOrb } from './AskOrb'
import { PlutusLogo } from './brand/PlutusLogo'

type Message =
  | { id: number; from: 'you'; text: string }
  | {
      id: number
      from: 'plutus'
      /** reading: rules, then perhaps the local AI; done: an answer, or a reply saying what went wrong */
      state: 'reading' | 'done'
      byAi?: boolean
      answer?: AskAnswer
      /** A reply that isn't an answer: not understood, no local AI, an error. */
      reply?: string
      /** Words the rules couldn't place, when there was no local AI to ask. */
      unsure?: string[]
      /** Offer to set up the local AI. */
      offerAi?: boolean
      /** The local AI is set up but couldn't be reached for this one (not started, not answering). */
      aiFailed?: boolean
    }

/** Ask Plutus: questions about your spending, answered from your files on this Mac. Rules read the question first
 *  (lib/askRules.ts); the local AI only when they're unsure (POST /api/ask; it never sees a transaction); the answer
 *  is always computed here, from the ledger, the way the dashboard counts (lib/ask.ts). The chat lives only while
 *  the page is open. */
export function AskPanel({ open, onOpen, onClose, data, onShow }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The ledger as the dashboard shows it (investments left out when you chose so). */
  data: LedgerData
  onShow: (ids: string[], label: string) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  // set up, but it couldn't be reached when a question needed it: said as such, not as "not set up"
  const [aiFailed, setAiFailed] = useState(false)
  const nextId = useRef(1)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const orb = useRef<HTMLButtonElement>(null)

  const ctx: AskContext = useMemo(() => ({
    categories: data.categories,
    payees: [...new Set([...data.txns, ...data.leftOut].map((t) => t.payee))],
    cards: data.cards,
    today: new Date().toLocaleDateString('en-CA'),
  }), [data])
  const starters = useMemo(() => suggestions(data), [data])
  const years = useMemo(() => periodsIn(data).slice().reverse(), [data])
  const lastQuery = [...messages].reverse().find((m): m is Extract<Message, { from: 'plutus' }> => m.from === 'plutus' && !!m.answer)?.answer?.query ?? null

  // the local AI: whether there's one to ask (checked each time the panel opens); focus to the question, and back to
  // the orb when it closes
  useEffect(() => {
    if (!open) return
    setAiFailed(false)
    api.llmStatus().then((s) => setAiReady(s.state !== 'unavailable' && s.modelInstalled !== false)).catch(() => setAiReady(false))
    requestAnimationFrame(() => input.current?.focus())
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      orb.current?.focus()
    }
  }, [open, onClose])

  // the answers stay true: a file read since, a category changed, the investments switch, and they're worked out again
  useEffect(() => {
    setMessages((all) => all.map((m) => (m.from === 'plutus' && m.answer ? { ...m, answer: answer(data, m.answer.query) } : m)))
  }, [data])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const update = (id: number, change: Partial<Extract<Message, { from: 'plutus' }>>) =>
    setMessages((all) => all.map((m) => (m.id === id && m.from === 'plutus' ? { ...m, ...change } : m)))

  const ask = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    setDraft('')
    setBusy(true)
    const you = nextId.current++
    const id = nextId.current++
    setMessages((all) => [...all, { id: you, from: 'you', text: question }, { id, from: 'plutus', state: 'reading' }])
    const previous = lastQuery
    try {
      const reading = readQuestion(question, ctx, previous)
      if (reading?.sure) {
        update(id, { state: 'done', answer: answer(data, reading.query) })
        return
      }
      if (aiReady) {
        update(id, { byAi: true })
        const res = await api.ask(question, previous)
        if (res.understood && res.query) {
          update(id, { state: 'done', byAi: true, answer: answer(data, fromAi(res.query, reading?.query, ctx)) })
          return
        }
        update(id, { state: 'done', byAi: true, reply: "I couldn't read that as a question about your spending. Try one of these:" })
        return
      }
      noAi(id, reading)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_ai') {
        setAiReady(false)
        setAiFailed(true)
        noAi(id, readQuestion(question, ctx, previous), true)
      } else {
        update(id, { state: 'done', byAi: false, reply: `Something went wrong reading that (${(e as Error).message}). Your data is fine; try again.` })
      }
    } finally {
      setBusy(false)
    }
  }

  /** Without a local AI: what the rules understood, said as such, when they found something to go on (a category, a
   *  payee, a period…); otherwise not answered, with questions to try and the way to more. Never a guess dressed up
   *  as an answer. */
  const noAi = (id: number, reading: ReturnType<typeof readQuestion>, failed = false) => {
    // read by the rules, never marked as the AI's, whatever was tried first
    const said = { state: 'done' as const, byAi: false, offerAi: true, aiFailed: failed }
    if (reading && hasSubstance(reading.query)) update(id, { ...said, answer: answer(data, reading.query), unsure: reading.unknown })
    else update(id, { ...said, reply: "I couldn't read that. Try asking like one of these:" })
  }

  const rerun = (id: number, query: AskQuery) => update(id, { answer: answer(data, query) })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void ask(draft)
  }

  return (
    <>
      <AskOrb ref={orb} open={open} busy={busy} onOpen={onOpen} />
      <AnimatePresence>
        {open && (
          <motion.aside
            role="dialog"
            aria-label="Ask Plutus"
            initial={{ x: '100%', opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0.6 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-white/10 bg-panel/95 text-left shadow-2xl shadow-black/60 backdrop-blur-xl sm:w-[440px]"
          >
            <header className="flex items-start gap-3 border-b border-white/[0.06] px-5 pt-5 pb-4">
              <PlutusLogo className="-my-0.5 size-8 shrink-0" title="" />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-[17px] font-semibold tracking-tight">Ask Plutus</h2>
                <p className="text-xs text-zinc-400">
                  Answers from your files, on this Mac{' '}
                  {aiReady === false ? (
                    <>
                      · rules only,{' '}
                      <button type="button" onClick={aiPanel.open} className="text-zinc-300 underline decoration-white/25 underline-offset-2 hover:decoration-white">
                        {aiFailed ? 'local AI unavailable' : 'local AI not set up'}
                      </button>
                    </>
                  ) : aiReady ? (
                    '· with your local AI'
                  ) : null}
                </p>
              </div>
              {messages.length > 0 && (
                <button type="button" onClick={() => setMessages([])} disabled={busy} title="Clear the chat" aria-label="Clear the chat"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30">
                  <RotateCcw className="size-4" />
                </button>
              )}
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                <X className="size-5" />
              </button>
            </header>

            <div ref={scroller} role="log" aria-label="Conversation" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {messages.length === 0 ? (
                <Welcome starters={starters} onPick={(q) => void ask(q)} />
              ) : (
                messages.map((m) =>
                  m.from === 'you' ? (
                    <p key={m.id} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.08] px-3.5 py-2 text-sm text-zinc-100">
                      {m.text}
                    </p>
                  ) : (
                    <Reply key={m.id} m={m} data={data} years={years} starters={starters}
                      onAsk={(q) => void ask(q)} onChange={(q) => rerun(m.id, q)} onShow={onShow} />
                  ),
                )
              )}
            </div>

            <form onSubmit={submit} className="border-t border-white/[0.06] px-4 py-3">
              <div className="flex items-center gap-2 rounded-2xl bg-black/30 py-1.5 pr-1.5 pl-4 ring-1 ring-white/10 focus-within:ring-white/25">
                <input
                  ref={input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={300}
                  placeholder="Ask about your spending…"
                  aria-label="Your question"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                />
                <button type="submit" disabled={!draft.trim() || busy} aria-label="Ask"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-zinc-950 transition hover:bg-zinc-200 disabled:bg-white/15 disabled:text-zinc-500">
                  <ArrowUp className="size-4" strokeWidth={2.4} />
                </button>
              </div>
            </form>
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  )
}

/** Whether a reading has something to go on beyond the kind of question: a category, a payee, a card, how it was paid,
 *  money in, or a period. */
const hasSubstance = (q: AskQuery) => q.categories.length > 0 || q.payees.length > 0 || q.cards.length > 0 || q.channel !== 'all' || q.money === 'in' || q.period !== null

/** The local AI's reading, as the page's query: periods named here; cards the rules found kept (the model is never
 *  told your cards); a kind of payee it gave as a name ("shops", "the electricity company") left out. */
function fromAi(q: AiQuery, rules: AskQuery | undefined, ctx: AskContext): AskQuery {
  return {
    ...emptyQuery(q.kind),
    ...q,
    payees: q.payees.filter((p) => couldBePayee(p, ctx)),
    cards: rules?.cards ?? [],
    period: q.period ? rangePeriod(q.period.from, q.period.to) : null,
    compareTo: q.compareTo ? rangePeriod(q.compareTo.from, q.compareTo.to) : null,
  }
}

function Welcome({ starters, onPick }: { starters: string[]; onPick: (q: string) => void }) {
  return (
    <div className="pt-6 text-center">
      <p className="font-display text-[15px] text-zinc-200">Ask about your spending</p>
      <p className="mx-auto mt-1 max-w-[30ch] text-sm text-zinc-400">Totals, top payees, months, comparisons. Every number comes from your files.</p>
      <div className="mt-5 flex flex-col items-center gap-2">
        {starters.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)}
            className="rounded-full px-3.5 py-1.5 text-[13px] text-zinc-300 ring-1 ring-white/10 transition hover:bg-white/[0.05] hover:text-zinc-100">
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function Reply({ m, data, years, starters, onAsk, onChange, onShow }: {
  m: Extract<Message, { from: 'plutus' }>
  data: LedgerData
  years: number[]
  starters: string[]
  onAsk: (q: string) => void
  onChange: (q: AskQuery) => void
  onShow: (ids: string[], label: string) => void
}) {
  if (m.state === 'reading') {
    return (
      <div className="flex items-center gap-2.5 text-sm text-zinc-400">
        <span className="size-2 animate-pulse rounded-full bg-zinc-400" />
        {m.byAi ? 'The local AI is reading your question…' : 'Reading your question…'}
      </div>
    )
  }
  if (!m.answer) {
    return (
      <div className="space-y-2.5">
        <p className="text-sm text-zinc-300">{m.reply}</p>
        <div className="flex flex-wrap gap-1.5">
          {starters.map((s) => (
            <button key={s} type="button" onClick={() => onAsk(s)} className="rounded-full px-3 py-1 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/[0.05]">
              {s}
            </button>
          ))}
        </div>
        {m.offerAi && <AiNote failed={!!m.aiFailed} />}
      </div>
    )
  }
  const a = m.answer
  const label = readingLabel(a.query, data)
  return (
    <article className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.07]">
      {a.figure && <p className="font-display text-[28px] leading-none font-semibold tracking-tight text-zinc-50 tabular-nums">{a.figure}</p>}
      <p className={`text-sm text-zinc-300 ${a.figure ? 'mt-2' : ''}`}>{a.sentence}</p>
      {a.lines.length > 0 && <Lines lines={a.lines} query={a.query} />}
      {a.matchedPayees.length > 0 && (
        <p className="mt-2 text-xs text-zinc-400">Counted: {a.matchedPayees.slice(0, 6).join(', ')}{a.matchedPayees.length > 6 ? ` and ${a.matchedPayees.length - 6} more` : ''}</p>
      )}
      <Reading query={a.query} data={data} years={years} byAi={!!m.byAi} onChange={onChange} />
      {(m.unsure?.length ?? 0) > 0 && (
        <p className="mt-2.5 flex gap-1.5 text-xs text-amber-200/90">
          <Info className="mt-px size-3.5 shrink-0" />
          I wasn’t sure about “{m.unsure!.join(', ')}”, so this is what I understood. Change the reading below, or ask another way.
        </p>
      )}
      {a.notes.map((n) => (
        <p key={n} className="mt-2 flex gap-1.5 text-xs text-zinc-400">
          <Info className="mt-px size-3.5 shrink-0 text-zinc-600" />
          {n}
        </p>
      ))}
      {a.ids.length > 0 && (
        <button type="button" onClick={() => onShow(a.ids, `your question: ${label}`)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06]">
          <ListFilter className="size-3.5" />
          {showLabel(a)}
        </button>
      )}
      {m.offerAi && (m.unsure?.length ?? 0) > 0 && <AiNote failed={!!m.aiFailed} />}
    </article>
  )
}

/** Under an answer the rules gave alone: how the local AI would help, or, when it's set up but couldn't be reached,
 *  that it couldn't (the Local AI panel says why). */
function AiNote({ failed }: { failed: boolean }) {
  return (
    <p className="mt-2.5 text-xs text-zinc-400">
      {failed ? "The local AI couldn't be reached, so the rules read this one." : 'With the local AI set up, Plutus can read questions like this one.'}{' '}
      <button type="button" onClick={aiPanel.open} className="text-zinc-300 underline decoration-white/25 underline-offset-2 hover:decoration-white">
        {failed ? 'See why' : 'See how'}
      </button>
    </p>
  )
}

/** The rows of an answer: by month, top payees or categories, a comparison (with a thin bar each, one colour: one
 *  series, so no legend); a list of payments (without). Every bar has its value written beside it. */
function Lines({ lines, query }: { lines: AskLine[]; query: AskQuery }) {
  const bars = ['trend', 'top', 'compare'].includes(query.kind)
  // why it changed: each line is a change, + or −, in the same neutral ink (less spending isn't money coming in)
  const changes = query.kind === 'why'
  const max = Math.max(...lines.map((l) => l.amount), 1)
  return (
    <ul className="mt-3 space-y-1.5">
      {lines.map((l, i) => (
        <li key={`${l.label}-${i}`} className="flex items-center gap-3 text-[13px]">
          <span className={`shrink-0 truncate text-zinc-300 ${bars ? (query.kind === 'trend' ? 'w-9' : 'w-32') : 'min-w-0 flex-1'}`} title={l.label}>
            {query.kind === 'trend' && l.month ? monthLabel(l.month) : l.label}
            {!bars && l.detail && <span className="block truncate text-xs text-zinc-400">{l.detail}</span>}
          </span>
          {bars && (
            <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-white/[0.04]" aria-hidden>
              <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(0, (l.amount / max) * 100)}%`, background: 'var(--color-series-1)' }} />
            </span>
          )}
          {changes ? (
            <span className="shrink-0 text-zinc-200 tabular-nums">{`${l.amount > 0 ? '+' : l.amount < 0 ? '−' : ''}${inr(Math.abs(l.amount))}`}</span>
          ) : (
            <span className={`shrink-0 tabular-nums ${l.amount < 0 ? 'text-emerald-300' : 'text-zinc-200'}`}>
              {l.amount < 0 ? `+${inrExact(-l.amount)}` : bars ? inr(l.amount) : inrExact(l.amount)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** "How I read it": the reading, as chips you can change. Remove a filter, or pick another period, and the answer is
 *  worked out again. */
function Reading({ query, data, years, byAi, onChange }: { query: AskQuery; data: LedgerData; years: number[]; byAi: boolean; onChange: (q: AskQuery) => void }) {
  const chip = 'inline-flex items-center gap-1 rounded-full bg-white/[0.05] py-0.5 pr-1.5 pl-2.5 text-xs text-zinc-300 ring-1 ring-white/[0.08]'
  const remove = (label: string, change: Partial<AskQuery>) => (
    <span className={chip}>
      {label}
      <button type="button" onClick={() => onChange({ ...query, ...change })} aria-label={`Remove ${label}`} className="rounded-full p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100">
        <X className="size-3" />
      </button>
    </span>
  )
  const periodValue = query.period ? (query.period.label === String(Number(query.period.label)) ? query.period.label : 'custom') : 'all'
  /** A chip that picks a period: the one asked about (when it isn't a year), a year, or (`first`) a choice at the top.
   *  The choice shows as text with the native list over it, so the chip is as wide as what's chosen (a select is as wide
   *  as its longest choice). */
  const pick = (name: string, value: string, custom: AskPeriod | null, first: [string, string] | null, onPick: (value: string) => void) => (
    <label className={`${chip} relative pr-1 focus-within:ring-white/40`}>
      <span className="sr-only">{name}</span>
      <span aria-hidden className="pr-4 text-xs text-zinc-300">{value === 'custom' ? custom?.label : first && value === first[0] ? first[1] : value}</span>
      <select value={value} onChange={(e) => onPick(e.target.value)} className="absolute inset-0 w-full cursor-pointer appearance-none opacity-0">
        {value === 'custom' && custom && <option value="custom" className="bg-zinc-900">{custom.label}</option>}
        {first && <option value={first[0]} className="bg-zinc-900">{first[1]}</option>}
        {years.map((y) => (
          <option key={y} value={String(y)} className="bg-zinc-900">{y}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-zinc-500" aria-hidden />
    </label>
  )
  const asYear = (p: AskPeriod | null) => (p && p.label === String(Number(p.label)) ? p.label : 'custom')
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/[0.05] pt-3">
      <span className="mr-0.5 flex items-center gap-1 text-[11px] tracking-wide text-zinc-400 uppercase">
        {byAi && (
          <>
            <Sparkles className="size-3" aria-hidden />
            <span className="sr-only">Read by the local AI:</span>
          </>
        )}
        How I read it
      </span>
      {query.categories.map((c) => <span key={c}>{remove(data.categories.get(c)?.label ?? c, { categories: query.categories.filter((x) => x !== c) })}</span>)}
      {query.payees.map((p) => <span key={p}>{remove(`“${p}”`, { payees: query.payees.filter((x) => x !== p) })}</span>)}
      {query.cards.map((c) => {
        const card = data.cards.find((x) => x.id === c)
        return <span key={c}>{remove(card ? `${card.issuer ?? 'Card'} ••${card.last4}` : 'a card', { cards: query.cards.filter((x) => x !== c) })}</span>
      })}
      {query.channel !== 'all' && remove(query.channel === 'upi' ? 'UPI only' : 'Cards only', { channel: 'all' })}
      {query.money === 'in' && !query.categories.length && <span className={`${chip} pr-2.5`}>Money in</span>}
      {query.kind === 'why' && query.period ? (
        // why it changed: the period asked about, against the period before (or another you pick)
        <>
          {pick('Period', asYear(query.period), query.period, null, (v) => onChange({ ...query, period: v === 'custom' ? query.period : yearPeriod(Number(v)) }))}
          <span className="text-xs text-zinc-400">against</span>
          {pick('Against', query.compareTo ? asYear(query.compareTo) : 'before', query.compareTo, ['before', `the period before (${periodBefore(query.period).label})`],
            (v) => onChange({ ...query, compareTo: v === 'before' ? null : v === 'custom' ? query.compareTo : yearPeriod(Number(v)) }))}
        </>
      ) : query.kind === 'compare' && query.compareTo ? (
        <span className={`${chip} pr-2.5`}>
          {query.period?.label} vs {query.compareTo.label}
        </span>
      ) : (
        <label className={`${chip} relative pr-1 focus-within:ring-white/40`}>
          <span className="sr-only">Period</span>
          <select
            value={periodValue}
            onChange={(e) => onChange({ ...query, period: e.target.value === 'all' ? null : e.target.value === 'custom' ? query.period : yearPeriod(Number(e.target.value)) })}
            className="cursor-pointer appearance-none bg-transparent pr-4 text-xs text-zinc-300 outline-none"
          >
            {periodValue === 'custom' && <option value="custom" className="bg-zinc-900">{query.period!.label}</option>}
            <option value="all" className="bg-zinc-900">All your files</option>
            {years.map((y) => (
              <option key={y} value={String(y)} className="bg-zinc-900">{y}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-zinc-500" aria-hidden />
        </label>
      )}
    </div>
  )
}

/** The reading in a few words, for the transactions list's "From your question: …". */
function readingLabel(q: AskQuery, data: LedgerData): string {
  const parts = [
    ...q.categories.map((c) => data.categories.get(c)?.label ?? c),
    ...q.payees.map((p) => `“${p}”`),
    q.channel === 'upi' ? 'UPI' : q.channel === 'cards' ? 'cards' : '',
    q.kind === 'why' && q.period ? `${q.period.label} against ${(q.compareTo ?? periodBefore(q.period)).label}`
      : q.kind === 'compare' && q.compareTo ? `${q.period?.label} vs ${q.compareTo.label}` : q.period?.label ?? 'all your files',
  ].filter(Boolean)
  return parts.join(' · ')
}
