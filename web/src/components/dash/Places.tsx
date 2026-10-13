import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, Info, ListFilter, MapPin, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../../api'
import { plural } from '../../lib/format'
import type { LedgerData } from '../../lib/ledger'
import { inr } from '../../lib/money'
import { dayLabel, type PeriodKey } from '../../lib/periods'
import { cleanPlace, daysBetween, placeLabel, placeTitle, STATES, stayPreview, staysIn, type StaySummary } from '../../lib/places'
import { OTHER_COLOUR, colourSlots, type TotalSpend } from '../../lib/totals'
import type { Stay } from '../../types'
import { SectionHead } from './Section'

/** Places: where you told Ask Plutus (or this section) you were, a card for each stay with days in the period: its
 *  days, what you spent on them and on what, and its payments. Edit and Remove here go through the same routes Ask
 *  Plutus uses (POST, PUT, DELETE /api/places), and change no payment: a place comes from a payment's day
 *  (lib/places.ts). Shown once you've told a place. */
export function Places({ data, period, allTime, onShow, onChanged, notify }: {
  data: LedgerData
  period: PeriodKey
  /** All years, which fixes each category's colour, as in Total spend. */
  allTime: TotalSpend
  onShow: (ids: string[], label: string) => void
  onChanged: () => void
  notify: (text: string) => void
}) {
  const summaries = useMemo(() => staysIn(data, period), [data, period])
  const slots = useMemo(() => colourSlots(allTime), [allTime])
  const [editing, setEditing] = useState<string | null>(null) // a stay's id, or 'new'
  const [removed, setRemoved] = useState<Stay | null>(null) // the one just removed, for Undo
  const [undoing, setUndoing] = useState(false)
  useEffect(() => setEditing(null), [period])
  useEffect(() => {
    if (!removed) return
    const timer = setTimeout(() => setRemoved(null), 15_000)
    return () => clearTimeout(timer)
  }, [removed])

  // shown once you've told a place; kept a moment after you remove the last one, so Undo is in reach
  if (!data.stays.length && !removed && editing !== 'new') return null

  const undo = async () => {
    if (!removed) return
    setUndoing(true)
    try {
      await api.addPlace({ place: removed.place, region: removed.region ?? null, start: removed.start, end: removed.end, id: removed.id, addedAt: removed.addedAt })
      setRemoved(null)
      onChanged()
    } catch (e) {
      notify(`Couldn't put it back: ${(e as Error).message}`)
    } finally {
      setUndoing(false)
    }
  }
  const when = period === 'all' ? 'all years' : String(period)

  return (
    <section className="mt-14" id="places">
      <SectionHead icon={<MapPin className="size-4" />} title="Places" note={`Where you told Ask Plutus you were · ${when}`} />
      <AnimatePresence initial={false}>
        {removed && (
          <motion.div
            key="undo"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            role="status"
            className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-zinc-900/95 px-4 py-2.5 ring-1 ring-white/15"
          >
            <p className="text-sm text-zinc-200">
              Removed: {placeLabel(removed)}, {span(removed.start, removed.end)}. Its payments no longer show a place.
            </p>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={undo} disabled={undoing} className="tap inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06] disabled:opacity-50">
                <Undo2 className="size-3.5" /> Undo
              </button>
              <button type="button" onClick={() => setRemoved(null)} aria-label="Dismiss" className="tap flex size-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                <X className="size-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid gap-4 md:grid-cols-2">
        {summaries.map((s) =>
          editing === s.stay.id ? (
            <StayForm key={s.stay.id} data={data} stay={s.stay} onDone={() => setEditing(null)} onChanged={onChanged} notify={notify} />
          ) : (
            <StayCard
              key={s.stay.id}
              s={s}
              data={data}
              period={period}
              colourOf={(id) => slots.get(id) ?? OTHER_COLOUR}
              onShow={onShow}
              onEdit={() => setEditing(s.stay.id)}
              onRemoved={(stay) => {
                setRemoved(stay)
                onChanged()
              }}
              notify={notify}
            />
          ),
        )}
        {editing === 'new' ? (
          <StayForm data={data} onDone={() => setEditing(null)} onChanged={onChanged} notify={notify} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-white/15 p-5 text-sm text-zinc-300 transition hover:border-white/30 hover:bg-white/[0.02] hover:text-zinc-100"
          >
            <Plus className="size-5" />
            Add a place
            <span className="max-w-[34ch] text-center text-xs text-balance text-muted">Or tell Ask Plutus: “I was in Goa from 1 to 5 Jan”</span>
          </button>
        )}
      </div>
      {data.stays.length > 0 && !summaries.length && <p className="mt-3 text-sm text-muted">None of your places have days in {when}.</p>}
    </section>
  )
}

const span = (start: string, end: string) => (start === end ? dayLabel(start) : `${dayLabel(start)} – ${dayLabel(end)}`)
/** India's states and union territories, by name, for the form's list. */
const STATE_CHOICES = Object.entries(STATES).sort((a, b) => a[1].localeCompare(b[1]))

function StayCard({ s, data, period, colourOf, onShow, onEdit, onRemoved, notify }: {
  s: StaySummary
  data: LedgerData
  period: PeriodKey
  colourOf: (id: string) => string
  onShow: (ids: string[], label: string) => void
  onEdit: () => void
  onRemoved: (stay: Stay) => void
  notify: (text: string) => void
}) {
  const { stay, days, spent, payments, ids, categories, estimated } = s
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const max = categories[0]?.amount ?? 0
  const label = `${placeLabel(stay)}, ${span(stay.start, stay.end)}`
  const remove = async () => {
    setBusy(true)
    try {
      onRemoved(await api.removePlace(stay.id))
    } catch (e) {
      notify(`Couldn't remove it: ${(e as Error).message}`)
      setBusy(false)
    }
  }
  const icon = 'tap flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100'
  return (
    <article aria-label={label} className="min-w-0 rounded-3xl border border-white/[0.07] bg-card/90 p-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 font-display text-[17px] font-semibold tracking-tight">
            <MapPin className="size-4 shrink-0 text-zinc-400" />
            <span className="truncate" title={placeTitle(stay)}>{placeLabel(stay)}</span>
          </h3>
          <p className="mt-0.5 text-sm text-muted tabular-nums">
            {span(stay.start, stay.end)} · {plural(daysBetween(stay.start, stay.end), 'day')}
          </p>
        </div>
        <button type="button" onClick={onEdit} aria-label={`Edit ${label}`} title="Change its place, state or days" className={icon}>
          <Pencil className="size-4" />
        </button>
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Remove ${label}`} title="Remove it" className={icon}>
          <Trash2 className="size-4" />
        </button>
      </header>

      <p className="mt-4 font-display text-[28px] leading-none font-semibold tracking-tight text-zinc-50 tabular-nums">{inr(spent)}</p>
      <p className="mt-1.5 text-xs text-muted tabular-nums">
        {days ? `${inr(spent / days)} a day over ${plural(days, 'day')}${period === 'all' ? '' : ` in ${period}`} · ${plural(payments, 'payment')}` : 'Every one of its days is now a place you told later.'}
      </p>
      {estimated > 0.5 && (
        <p className="mt-1 text-xs text-muted tabular-nums" title="A card bill has no payments, so its spending has no place">
          Not in this: about {inr(estimated)} of card spending estimated from bills over these days
        </p>
      )}

      {categories.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label={`What you spent on in ${placeLabel(stay)}`}>
          {categories.slice(0, 3).map((c) => (
            <li key={c.id} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-[13px]">
              <span className="truncate text-zinc-300">{data.categories.get(c.id)?.label ?? c.id}</span>
              <span className="h-1.5 rounded-r" style={{ width: `${Math.max(2, (c.amount / max) * 100)}%`, background: colourOf(c.id) }} aria-hidden />
              <span className="text-zinc-200 tabular-nums">{inr(c.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {confirming ? (
        <div className="mt-4 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/[0.08]">
          <p className="text-sm text-zinc-200">Remove {label}?</p>
          <p className="mt-0.5 text-xs text-muted">Its payments no longer show a place; nothing else changes.</p>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={remove} disabled={busy} className="tap rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50">
              Remove
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="tap rounded-full px-3 py-1.5 text-[13px] text-zinc-300 ring-1 ring-white/15 transition hover:bg-white/[0.06]">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        ids.length > 0 && (
          <button
            type="button"
            onClick={() => onShow(ids, label)}
            className="tap mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06]"
          >
            <ListFilter className="size-3.5" /> Show {payments === 1 ? 'this payment' : `these ${payments} payments`}
          </button>
        )
      )}
    </article>
  )
}

/** A stay added here, or one changed: its place, its state (one of India's, or none) and its days, checked as the
 *  server checks them, with what it would take from places told before. */
function StayForm({ data, stay, onDone, onChanged, notify }: {
  data: LedgerData
  stay?: Stay
  onDone: () => void
  onChanged: () => void
  notify: (text: string) => void
}) {
  const [place, setPlace] = useState(stay?.place ?? '')
  const [region, setRegion] = useState(stay?.region ?? '')
  const [start, setStart] = useState(stay?.start ?? '')
  const [end, setEnd] = useState(stay?.end ?? '')
  const [saving, setSaving] = useState(false)
  const name = cleanPlace(place)
  const days = start && end && start <= end
  const problem = !place.trim() ? null : !name ? 'A place is a short name, up to 40 letters, like “Goa” or “North Goa”.' : start && end && start > end ? 'The first day comes before the last.' : null
  const others = useMemo(() => ({ ...data, stays: data.stays.filter((s) => s.id !== stay?.id) }), [data, stay])
  const preview = name && days ? stayPreview(others, start, end, name, region || null) : null
  const kept = name ? placeLabel({ place: name, region: region || null }) : ''
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name || !days) return
    setSaving(true)
    try {
      if (stay) await api.changePlace(stay.id, { place: name, region: region || null, start, end })
      else await api.addPlace({ place: name, region: region || null, start, end })
      notify(`${kept}, ${span(start, end)}: ${stay ? 'changed' : 'kept'}`)
      onDone()
      onChanged()
    } catch (err) {
      notify(`Couldn't save it: ${(err as Error).message}`)
      setSaving(false)
    }
  }
  const field = 'mt-1 w-full rounded-xl bg-black/30 px-3 py-2 text-sm text-zinc-100 ring-1 ring-white/10 outline-none placeholder:text-muted focus:ring-white/40'
  return (
    <form onSubmit={save} aria-label={stay ? `Change ${placeLabel(stay)}` : 'Add a place'} className="min-w-0 rounded-3xl border border-white/[0.14] bg-card/90 p-5">
      <p className="flex items-center gap-2 font-display text-[17px] font-semibold tracking-tight">
        <MapPin className="size-4 text-zinc-400" /> {stay ? 'Change this place' : 'Add a place'}
      </p>
      <label className="mt-3 block text-xs text-zinc-400">
        Place
        <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={40} placeholder="Goa" autoFocus className={field} />
      </label>
      <label className="mt-3 block text-xs text-zinc-400">
        State
        <span className="relative mt-1 block">
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={`${field} mt-0 cursor-pointer appearance-none pr-9`}>
            <option value="" className="bg-zinc-900">No state</option>
            {STATE_CHOICES.map(([code, name]) => (
              <option key={code} value={code} className="bg-zinc-900">{name} ({code})</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
        </span>
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-xs text-zinc-400">
          From
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} max={end || undefined} className={field} />
        </label>
        <label className="block text-xs text-zinc-400">
          To
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} min={start || undefined} className={field} />
        </label>
      </div>
      {problem && <p className="mt-2 text-xs text-rose-300">{problem}</p>}
      {preview && (
        <div className="mt-3 space-y-1.5 text-xs">
          <p className="text-zinc-400 tabular-nums">
            {plural(preview.days, 'day')} · {preview.payments ? `${plural(preview.payments, 'payment')} on those days, ${inr(preview.spent)} spent` : 'no payments on those days in your files yet'}
          </p>
          {preview.taken.map((x) => (
            <p key={x.stay.id} className="flex gap-1.5 text-amber-200/90">
              <Info className="mt-px size-3.5 shrink-0" /> {span(x.start, x.end)} {x.start === x.end ? 'was' : 'were'} {placeLabel(x.stay)}: {x.start === x.end ? 'that day becomes' : 'those days become'} {kept}.
            </p>
          ))}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button type="submit" disabled={!name || !days || saving} className="tap rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50">
          {saving ? 'Saving…' : stay ? 'Save' : 'Add'}
        </button>
        <button type="button" onClick={onDone} disabled={saving} className="tap rounded-full px-3 py-1.5 text-[13px] text-zinc-300 ring-1 ring-white/15 transition hover:bg-white/[0.06]">
          Cancel
        </button>
      </div>
    </form>
  )
}
