import { AnimatePresence, motion } from 'motion/react'
import { ArrowUp, Check, ChevronDown, Info, ListFilter, MapPin, RotateCcw, Sparkles, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import { answer, emptyQuery, periodBefore, rangePeriod, showLabel, suggestions, yearPeriod, type AskAnswer, type AskLine, type AskPeriod, type AskQuery } from '../lib/ask'
import { couldBePayee, readQuestion, readStay, type AskContext, type StayReading } from '../lib/askRules'
import { aiPanel } from '../lib/aiPanel'
import { periodsIn, type LedgerData } from '../lib/ledger'
import { inr, inrExact } from '../lib/money'
import { plural } from '../lib/format'
import { dayLabel, monthLabel } from '../lib/periods'
import { parsePlace, placeKey, placeLabel, samePlace, STATES, stayPreview, toldBefore } from '../lib/places'
import type { AiAction, AiQuery, Stay } from '../types'
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
      /** Something you told: a stay to keep, or stays to forget, shown first and done only by its button. */
      told?: Told
    }

/** A place, with its state when it has one. */
type Where = { place: string; region: string | null }

/** A stay to keep or stays to forget, and where that stands: asked, being saved, done (Undo can put it back), undone,
 *  cancelled. `changed`: what was saved or removed, as the server has it, for Undo. */
type Told = {
  what:
    | {
        kind: 'stay'
        start: string
        end: string
        /** The place as you wrote it, with the state you wrote, if any. */
        written: Where
        /** What it could be, each a button: as you wrote it with your state, the same name you gave a state before, or
         *  what your local AI read it as. Empty: kept as written. */
        choices: Where[]
        /** Your local AI is reading the place (only its words). */
        checking?: boolean
        /** Why it's kept as written without a state: no local AI, it doesn't know the place, or it couldn't be reached. */
        why?: 'no-ai' | 'unknown' | 'failed'
        /** The place you chose with its button. */
        chosen?: Where
      }
    | { kind: 'forget'; stays: Stay[]; partOf: boolean }
  status: 'ask' | 'saving' | 'done' | 'undoing' | 'undone' | 'cancelled'
  changed?: Stay[]
  error?: string
}

/** Ask Plutus: questions about your spending, answered from your files on this Mac. Rules read the question first
 *  (lib/askRules.ts); the local AI only when they're unsure (POST /api/ask; it never sees a transaction); the answer
 *  is always computed here, from the ledger, the way the dashboard counts (lib/ask.ts). The chat lives only while
 *  the page is open. */
export function AskPanel({ open, onOpen, onClose, data, onShow, onChanged }: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The ledger as the dashboard shows it (investments left out when you chose so). */
  data: LedgerData
  onShow: (ids: string[], label: string) => void
  /** After a stay you confirmed is kept or removed: the ledger, read again. */
  onChanged: () => void
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
    payees: [...new Set([...data.txns, ...data.leftOut].flatMap((t) => [t.payee, t.shop]))], // as files print them, and their shops
    cards: data.cards,
    places: [...new Map(data.stays.map((s) => [placeKey(s.place), s.place])).values()],
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
      // telling, not asking: where you were, or weren't. A reply shows what it would do; only its button does it.
      const told = readStay(question, ctx)
      if (told && (told.kind === 'forget' || told.start)) {
        show(id, tell(told))
        return
      }
      if (/^\s*(yes|yep|yeah|ok|okay|sure|confirm|do it|go ahead)\b/i.test(question) && pending()) {
        update(id, { state: 'done', reply: 'To keep it, press the button on it above: typing doesn’t change anything.' })
        return
      }
      if (told && aiReady) {
        // a stay whose days the rules couldn't place exactly ("the second week of March"): the local AI reads the days;
        // if it can't be reached, the reply asks when instead
        update(id, { byAi: true })
        const res = await api.ask(question, previous).catch(() => null)
        if (res?.action?.kind === 'stay' && res.action.from && res.action.to) {
          show(id, { byAi: true, ...tell({ ...told, start: res.action.from, end: res.action.to }) })
          return
        }
        update(id, { byAi: false })
      }
      if (told) {
        const place = placeLabel(told)
        update(id, { state: 'done', reply: `When were you in ${place}? Tell me the days, like “I was in ${place} from 1 to 5 Jan 2026”.` })
        return
      }
      const reading = readQuestion(question, ctx, previous)
      if (reading?.sure) {
        update(id, { state: 'done', answer: answer(data, reading.query) })
        return
      }
      if (aiReady) {
        update(id, { byAi: true })
        const res = await api.ask(question, previous)
        if (res.action) {
          show(id, { byAi: true, ...fromAiAction(res.action) })
          return
        }
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

  /** Whether a stay you told is still waiting for its button. */
  const pending = () => messages.some((m) => m.from === 'plutus' && m.told?.status === 'ask')

  /** The reply to something you told: what it would do, to confirm; or why there's nothing to do. A place without a
   *  state is offered with the state you gave the same name before; failing that, your local AI is asked (`show`). */
  const tell = (told: StayReading): Partial<Extract<Message, { from: 'plutus' }>> => {
    if (told.kind === 'stay') {
      const written = { place: told.place, region: told.region }
      const choices = written.region ? [written] : toldBefore(written.place, data.stays)
      const checking = !choices.length && aiReady !== false
      return { state: 'done', told: { what: { kind: 'stay', start: told.start!, end: told.end!, written, choices, checking, why: choices.length || checking ? undefined : 'no-ai' }, status: 'ask' } }
    }
    const named = told.place
    // a state named picks that state's stays, and those told without one
    let stays = data.stays.filter((s) => !named || (samePlace(s.place, named) && (!told.region || !s.region || s.region === told.region)))
    if (told.start && told.end) stays = stays.filter((s) => s.start <= told.end! && told.start! <= s.end)
    if (!stays.length) {
      const reply = !data.stays.length ? 'You haven’t told me any places yet.' : named ? `You haven’t told me about ${placeLabel({ place: named, region: told.region })}${told.start ? ' on those days' : ''}.` : 'There are no places on those days.'
      return { state: 'done', reply }
    }
    const partOf = !!(told.start && told.end && stays.some((s) => s.start < told.start! || s.end > told.end!))
    return { state: 'done', told: { what: { kind: 'forget', stays, partOf }, status: 'ask' } }
  }

  /** A reply shown; for a stay told without a state, your local AI asked about its place. */
  const show = (id: number, change: Partial<Extract<Message, { from: 'plutus' }>>) => {
    update(id, change)
    const what = change.told?.what
    if (what?.kind === 'stay' && what.checking) void checkPlace(id, what.written.place)
  }

  /** Your local AI reads a place you told: only its words, never a payment or the rest of the sentence. What it says,
   *  checked by the server, is shown as a button each; when it doesn't know the place, or isn't there, it's kept as you
   *  wrote it, and the card says so. */
  const checkPlace = async (id: number, written: string) => {
    let choices: Where[] = []
    let why: 'no-ai' | 'unknown' | 'failed' | undefined
    try {
      choices = (await api.readPlace(written)).places
      if (!choices.length) why = 'unknown'
    } catch (e) {
      // set up, as far as the page knew, but not there to ask: said as such, as for a question
      if (e instanceof ApiError && e.code === 'no_ai') {
        setAiReady(false)
        setAiFailed(true)
      }
      why = 'failed'
    }
    setMessages((all) => all.map((m) => (m.id === id && m.from === 'plutus' && m.told?.what.kind === 'stay'
      ? { ...m, told: { ...m.told, what: { ...m.told.what, checking: false, choices, why } } } : m)))
  }

  /** The local AI's reading of something you told, checked here too: a place that isn't a name, or days it couldn't
   *  read, and the reply asks instead. */
  const fromAiAction = (a: AiAction): Partial<Extract<Message, { from: 'plutus' }>> => {
    const read = a.place ? parsePlace(a.place) : null
    const place = (read && ctx.places.find((p) => samePlace(p, read.place))) ?? read?.place ?? null
    const region = read?.region ?? null
    if (a.kind === 'forget') return tell({ kind: 'forget', place, region, start: a.from, end: a.to })
    if (!place) return { state: 'done', reply: "I couldn't tell which place you mean. Try “I was in Goa from 1 to 5 Jan 2026”." }
    const label = placeLabel({ place, region })
    if (!a.from || !a.to) return { state: 'done', reply: `When were you in ${label}? Tell me the days, like “I was in ${label} from 1 to 5 Jan 2026”.` }
    return tell({ kind: 'stay', place, region, start: a.from, end: a.to })
  }

  const setTold = (id: number, change: Partial<Told>) =>
    setMessages((all) => all.map((m) => (m.id === id && m.from === 'plutus' && m.told ? { ...m, told: { ...m.told, ...change } } : m)))

  /** Your button: the stay kept, as the place you chose, or the stays removed, through the same routes the Places section
   *  uses. */
  const confirm = async (id: number, told: Told, choice?: Where) => {
    const what = told.what.kind === 'stay' && choice ? { ...told.what, chosen: choice } : told.what
    setTold(id, { what, status: 'saving', error: undefined })
    try {
      const changed = what.kind === 'stay'
        ? [await api.addPlace({ place: what.chosen!.place, region: what.chosen!.region, start: what.start, end: what.end })]
        : await Promise.all(what.stays.map((s) => api.removePlace(s.id)))
      setTold(id, { status: 'done', changed })
      onChanged()
    } catch (e) {
      setTold(id, { status: 'ask', error: (e as Error).message })
    }
  }

  /** Undo: a stay kept is removed; stays removed are put back exactly (their own ids, and when you told them). */
  const undo = async (id: number, told: Told) => {
    setTold(id, { status: 'undoing', error: undefined })
    try {
      if (told.what.kind === 'stay') await Promise.all((told.changed ?? []).map((s) => api.removePlace(s.id)))
      else await Promise.all((told.changed ?? []).map((s) => api.addPlace({ place: s.place, region: s.region ?? null, start: s.start, end: s.end, id: s.id, addedAt: s.addedAt })))
      setTold(id, { status: 'undone' })
      onChanged()
    } catch (e) {
      setTold(id, { status: 'done', error: (e as Error).message })
    }
  }

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
                      <button type="button" onClick={aiPanel.open} className="hit text-zinc-300 underline decoration-white/25 underline-offset-2 hover:decoration-white">
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
                    m.told ? (
                      <ToldCard key={m.id} told={m.told} data={data} onShow={onShow}
                        onConfirm={(choice) => void confirm(m.id, m.told!, choice)} onCancel={() => setTold(m.id, { status: 'cancelled' })} onUndo={() => void undo(m.id, m.told!)} />
                    ) : (
                      <Reply key={m.id} m={m} data={data} years={years} starters={starters}
                        onAsk={(q) => void ask(q)} onChange={(q) => rerun(m.id, q)} onShow={onShow} />
                    )
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
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-zinc-100 outline-none placeholder:text-muted"
                />
                <button type="submit" disabled={!draft.trim() || busy} aria-label="Ask"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-zinc-950 transition hover:bg-zinc-200 disabled:bg-white/15 disabled:text-muted">
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
    places: rules?.places ?? [], // the model is never told your places: the rules found them
    period: q.period ? rangePeriod(q.period.from, q.period.to) : null,
    compareTo: q.compareTo ? rangePeriod(q.compareTo.from, q.compareTo.to) : null,
  }
}

function Welcome({ starters, onPick }: { starters: string[]; onPick: (q: string) => void }) {
  return (
    <div className="pt-6 text-center">
      <p className="font-display text-[15px] text-zinc-200">Ask about your spending</p>
      <p className="mx-auto mt-1 max-w-[30ch] text-sm text-zinc-400">Totals, top payees, months, comparisons. Every number comes from your files.</p>
      <p className="mx-auto mt-2 max-w-[34ch] text-xs text-zinc-400">Tell me where you were, like “I was in Goa from 1 to 5 Jan”, and ask what you spent there.</p>
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
          <Info className="mt-px size-3.5 shrink-0 text-faint" />
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

/** Something you told, shown before anything is done: what it would do, in days, payments and money, and what it
 *  takes from places told before; for a stay, the place it would be, with its state, or a choice of them. Only a button
 *  does it; then it can be undone. */
function ToldCard({ told, data, onConfirm, onCancel, onUndo, onShow }: {
  told: Told
  data: LedgerData
  /** For a stay, the place chosen. */
  onConfirm: (choice?: Where) => void
  onCancel: () => void
  onUndo: () => void
  onShow: (ids: string[], label: string) => void
}) {
  const span = (start: string, end: string) => (start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`)
  const busy = told.status === 'saving' || told.status === 'undoing'
  const primary = 'tap inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50'
  const quiet = 'tap inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06] disabled:opacity-50'
  // one of several equal choices (a state each): above "Keep as written", below a single main action
  const choice = 'tap inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] px-3 py-1.5 text-[13px] font-medium text-zinc-50 ring-1 ring-white/20 transition hover:bg-white/[0.12] disabled:opacity-50'
  // the least: Cancel
  const ghost = 'tap inline-flex items-center rounded-full px-3 py-1.5 text-[13px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50'
  const spinner = <span className="size-3 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" />
  const outcome = (text: string) => (
    <p className="mt-3 flex items-center gap-1.5 text-sm text-zinc-200">
      <Check className="size-4 text-emerald-400" strokeWidth={2.6} /> {text}
    </p>
  )
  const error = told.error && <p className="mt-2 text-xs text-rose-300">That didn’t work: {told.error}. Nothing changed; try again.</p>
  const closed = told.status === 'cancelled' || told.status === 'undone'
  const note = (text: string) => (
    <p className="mt-2 flex gap-1.5 text-xs text-zinc-400">
      <Info className="mt-px size-3.5 shrink-0 text-faint" /> {text}
    </p>
  )

  if (told.what.kind === 'stay') {
    const { start, end, written, choices, checking, why, chosen } = told.what
    const asking = told.status === 'ask' || told.status === 'saving'
    const same = (a: Where, b: Where) => samePlace(a.place, b.place) && (a.region ?? null) === (b.region ?? null)
    const several = !chosen && choices.length > 1
    // the place it would be: the one you chose, else the one it can be, else as you wrote it (several: their name)
    const shown = chosen ?? (choices.length === 1 ? choices[0] : several ? { place: choices[0].place, region: null } : written)
    const label = placeLabel(shown)
    const named = several ? choices.every((c) => samePlace(c.place, shown.place)) : true
    const p = stayPreview(data, start, end, shown.place, shown.region)
    const days = span(start, end)
    const under = [
      shown.region && label !== shown.place ? STATES[shown.region] : null,
      named && !samePlace(shown.place, written.place) ? `you wrote “${written.place}”` : null,
    ].filter(Boolean).join(' · ')
    const pick = (c: Where, text: string, main: boolean) => (
      <button key={`${c.place}|${c.region}`} type="button" onClick={() => onConfirm(c)} disabled={busy} className={main ? primary : choice}
        title={c.region ? `${c.place}, ${STATES[c.region]}` : undefined}>
        {told.status === 'saving' && chosen && same(chosen, c) ? (main ? spinner : <span className="size-3 animate-spin rounded-full border-2 border-white/25 border-t-white" />) : <MapPin className="size-3.5" />} {text}
      </button>
    )
    const keepWritten = (
      <button type="button" onClick={() => onConfirm(written)} disabled={busy} className={quiet}>
        {told.status === 'saving' && chosen && same(chosen, written) && <span className="size-3 animate-spin rounded-full border-2 border-white/25 border-t-white" />} Keep as written
      </button>
    )
    return (
      <article role="group" aria-label={`${label}, ${days}`} className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.07]">
        <p className="flex items-center gap-2 font-display text-[17px] font-semibold tracking-tight text-zinc-50">
          <MapPin className="size-4 shrink-0 text-zinc-400" /> {named ? label : written.place}
        </p>
        {under && <p className="mt-0.5 text-xs text-zinc-400">{under}</p>}
        <p className="mt-1 text-sm text-zinc-300 tabular-nums">{days} · {plural(p.days, 'day')}</p>
        <p className="mt-1 text-xs text-zinc-400 tabular-nums">
          {p.payments ? `${plural(p.payments, 'payment')} on those days · ${inr(p.spent)} spent` : 'No payments on those days in your files yet; any you add later will show there.'}
        </p>
        {told.status === 'ask' && !several &&
          p.taken.map((x) => (
            <p key={x.stay.id} className="mt-2 flex gap-1.5 text-xs text-amber-200/90">
              <Info className="mt-px size-3.5 shrink-0" /> {span(x.start, x.end)} {x.start === x.end ? 'was' : 'were'} {placeLabel(x.stay)}: {x.start === x.end ? 'that day becomes' : 'those days become'} {label}.
            </p>
          ))}
        {error}
        {asking ? (
          <>
            {checking && !chosen ? (
              <p role="status" className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-zinc-400" /> Your local AI is checking its spelling and state…
              </p>
            ) : several ? (
              <p className="mt-2 text-xs text-zinc-300">
                {named ? `Places named ${shown.place} are in more than one state.` : 'It could be more than one place.'} Which one were you in?
              </p>
            ) : !choices.length && !chosen && !written.region && why ? (
              note(`${why === 'no-ai' ? 'No state with it' : why === 'unknown' ? 'Your local AI doesn’t know this place, so it has no state'
                : 'Your local AI couldn’t be reached to check it, so it has no state'}: write one after the place, like “Darjeeling, WB”, or add it in Places.`)
            ) : (
              <p className="mt-2 text-xs text-zinc-400">Nothing else changes: your payments and figures stay as they are, with {label} beside them.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {checking && !chosen ? keepWritten
                : several ? <>{choices.map((c) => pick(c, named ? STATES[c.region!] : `${c.place}, ${STATES[c.region!]}`, false))}{keepWritten}</>
                  : choices.length === 1 ? <>{pick(choices[0], `Mark as ${placeLabel(choices[0])}`, true)}{!same(choices[0], written) && keepWritten}</>
                    : pick(chosen ?? written, `Mark as ${placeLabel(chosen ?? written)}`, true)}
              <button type="button" onClick={onCancel} disabled={busy} className={ghost}>Cancel</button>
            </div>
          </>
        ) : closed ? (
          <p className="mt-3 text-sm text-zinc-400">{told.status === 'undone' ? 'Undone: nothing is kept.' : 'Cancelled: nothing changed.'}</p>
        ) : (
          <>
            {outcome(`Kept: ${days} ${start === end ? 'is' : 'are'} ${label}.`)}
            <div className="mt-3 flex flex-wrap gap-2">
              {p.ids.length > 0 && (
                <button type="button" onClick={() => onShow(p.ids, `${label}, ${days}`)} className={quiet}>
                  <ListFilter className="size-3.5" /> Show {p.payments === 1 ? 'this payment' : `these ${p.payments} payments`}
                </button>
              )}
              <button type="button" onClick={onUndo} disabled={busy} className={quiet}>
                <Undo2 className="size-3.5" /> Undo
              </button>
            </div>
          </>
        )}
      </article>
    )
  }

  const { stays, partOf } = told.what
  const one = stays.length === 1
  return (
    <article role="group" aria-label={one ? `Forget ${placeLabel(stays[0])}` : `Forget ${stays.length} places`} className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.07]">
      <p className="font-display text-[17px] font-semibold tracking-tight text-zinc-50">{one ? `Forget ${placeLabel(stays[0])}?` : `Forget these ${stays.length} places?`}</p>
      <ul className="mt-2 space-y-1">
        {stays.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm text-zinc-300 tabular-nums">
            <MapPin className="size-3.5 shrink-0 text-zinc-400" /> {placeLabel(s)} · {span(s.start, s.end)}
          </li>
        ))}
      </ul>
      {partOf && told.status === 'ask' && (
        <p className="mt-2 flex gap-1.5 text-xs text-amber-200/90">
          <Info className="mt-px size-3.5 shrink-0" /> Those days are part of {one ? 'it' : 'them'}. This forgets {one ? 'the whole stay' : 'each whole stay'}; to change the days instead, use Places.
        </p>
      )}
      {error}
      {told.status === 'ask' || told.status === 'saving' ? (
        <>
          <p className="mt-2 text-xs text-zinc-400">Their payments lose the place; nothing else changes.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => onConfirm()} disabled={busy} className={primary}>
              {told.status === 'saving' && spinner} {one ? 'Forget it' : 'Forget them'}
            </button>
            <button type="button" onClick={onCancel} disabled={busy} className={ghost}>Cancel</button>
          </div>
        </>
      ) : closed ? (
        <p className="mt-3 text-sm text-zinc-400">{told.status === 'undone' ? 'Undone: put back as it was.' : 'Cancelled: nothing changed.'}</p>
      ) : (
        <>
          {outcome(one ? `Forgotten: ${placeLabel(stays[0])}.` : `Forgotten: ${stays.length} places.`)}
          <div className="mt-3">
            <button type="button" onClick={onUndo} disabled={busy} className={quiet}>
              <Undo2 className="size-3.5" /> Undo
            </button>
          </div>
        </>
      )}
    </article>
  )
}

/** Under an answer the rules gave alone: how the local AI would help, or, when it's set up but couldn't be reached,
 *  that it couldn't (the Local AI panel says why). */
function AiNote({ failed }: { failed: boolean }) {
  return (
    <p className="mt-2.5 text-xs text-zinc-400">
      {failed ? "The local AI couldn't be reached, so the rules read this one." : 'With the local AI set up, Plutus can read questions like this one.'}{' '}
      <button type="button" onClick={aiPanel.open} className="hit text-zinc-300 underline decoration-white/25 underline-offset-2 hover:decoration-white">
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
  // 24px tall, WCAG's least target: the chip is a picker's whole target, and a remove button fills its height
  const chip = 'inline-flex items-center gap-1 rounded-full bg-white/[0.05] py-1 pr-1.5 pl-2.5 text-xs text-zinc-300 ring-1 ring-white/[0.08]'
  const remove = (label: string, change: Partial<AskQuery>) => (
    <span className={chip}>
      {label}
      <button type="button" onClick={() => onChange({ ...query, ...change })} aria-label={`Remove ${label}`} className="-my-1 rounded-full p-1.5 text-muted hover:bg-white/10 hover:text-zinc-100">
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
      <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-muted" aria-hidden />
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
      {query.places.map((p) => <span key={p}>{remove(`in ${p}`, { places: query.places.filter((x) => x !== p) })}</span>)}
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
          <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-muted" aria-hidden />
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
    ...q.places.map((p) => `in ${p}`),
    q.channel === 'upi' ? 'UPI' : q.channel === 'cards' ? 'cards' : '',
    q.kind === 'why' && q.period ? `${q.period.label} against ${(q.compareTo ?? periodBefore(q.period)).label}`
      : q.kind === 'compare' && q.compareTo ? `${q.period?.label} vs ${q.compareTo.label}` : q.period?.label ?? 'all your files',
  ].filter(Boolean)
  return parts.join(' · ')
}
