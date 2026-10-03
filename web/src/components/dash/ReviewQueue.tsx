import { AnimatePresence, motion } from 'motion/react'
import { Check, ChevronDown, CheckCheck, CircleDashed, Store, UserRound } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { plural } from '../../lib/format'
import { inr } from '../../lib/money'
import { dayLabel, type PeriodKey } from '../../lib/periods'
import { reviewQueue, unnamedWaiting } from '../../lib/ledger'
import type { CategoryNode, Transaction } from '../../types'
import { CategorySelect } from './CategorySelect'
import { Panel } from './Section'

const PAGE = 12
const COLLAPSED_KEY = 'plutus.review.collapsed'

type Group = ReturnType<typeof reviewQueue>[number]
type Draft = { category: string; label: string }

interface Props {
  txns: Transaction[]
  tree: CategoryNode[]
  period: PeriodKey
  onAllYears: () => void
  /** Opens the payments that don't say who was paid in the transactions list, to answer one by one. */
  onShowUnnamed: () => void
  onChanged: () => void
  notify: (text: string) => void
  id?: string
  className?: string
}

/** Payees the app couldn't place with confidence, biggest first, for the year picked at the top (so a long
 *  history is reviewed a year at a time). One answer fixes every payment to that payee, in every year, past and
 *  future. Answer them one by one, or all at once with "Looks right for all", which saves every row shown as it
 *  stands (your dropdown changes and names included). Collapses to its title. */
export function ReviewPanel({ txns, tree, period, onAllYears, onShowUnnamed, onChanged, notify, id, className }: Props) {
  const queue = useMemo(() => reviewQueue(txns, period), [txns, period])
  const unnamed = useMemo(() => unnamedWaiting(txns, period), [txns, period])
  const waitingAnywhere = useMemo(() => (period === 'all' ? queue.length : reviewQueue(txns).length), [txns, period, queue])
  const [collapsed, setCollapsed] = useState(() => readCollapsed())
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [shown, setShown] = useState(PAGE)
  const [confirming, setConfirming] = useState(false)
  const [savingAll, setSavingAll] = useState(false)

  useEffect(() => writeCollapsed(collapsed), [collapsed])
  useEffect(() => {
    if (collapsed) setConfirming(false)
  }, [collapsed])
  useEffect(() => {
    setShown(PAGE)
    setConfirming(false)
  }, [period])

  if (!waitingAnywhere && !unnamed.count) return null
  if (!queue.length && !unnamed.count) {
    return (
      <Panel
        id={id}
        className={className}
        title="Needs your eyes"
        note={`Nothing waiting in ${period}. ${plural(waitingAnywhere, 'payee')} in other years.`}
        actions={
          <button
            type="button"
            onClick={onAllYears}
            className="rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
          >
            Show all years
          </button>
        }
      />
    )
  }

  const draftOf = (g: Group): Draft => drafts[g.payee] ?? { category: g.category, label: '' }
  const setDraft = (payee: string, d: Draft) => setDrafts((all) => ({ ...all, [payee]: d }))
  const edited = queue.filter((g) => {
    const d = drafts[g.payee]
    return d && (d.category !== g.category || d.label.trim())
  }).length

  const saveAll = async () => {
    setSavingAll(true)
    try {
      const items = queue.map((g) => {
        const d = draftOf(g)
        return { payee: g.payee, category: d.category, label: d.label.trim() || undefined }
      })
      const res = await api.categorizeBulk(items)
      const mine = res.accounts ? ` · ${plural(res.accounts, 'account')} marked as yours` : ''
      notify(`${plural(res.confirmed, 'payee')} saved${mine} · ${plural(res.updated, 'payment')} updated`)
      setDrafts({})
      setConfirming(false)
      onChanged()
    } catch (err) {
      notify(`Couldn't save them: ${(err as Error).message}`)
    } finally {
      setSavingAll(false)
    }
  }

  const actions = (
    <>
      <AnimatePresence initial={false} mode="popLayout">
        {!collapsed &&
          queue.length > 0 &&
          (confirming ? (
            <motion.div key="confirm" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="flex items-center gap-2">
              <span className="hidden text-sm text-zinc-400 sm:inline">
                Save all {queue.length} as shown{edited ? `, ${edited} changed` : ''}?
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={savingAll}
                className="rounded-full px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveAll}
                disabled={savingAll}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-60"
              >
                {savingAll ? <span className="size-3.5 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" /> : <Check className="size-4" />}
                {savingAll ? 'Saving…' : `Save all ${queue.length}`}
              </button>
            </motion.div>
          ) : (
            <motion.button
              key="all"
              type="button"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
            >
              <CheckCheck className="size-4" />
              Looks right for all
            </motion.button>
          ))}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show the payees to review' : 'Collapse'}
        className="flex size-8 items-center justify-center rounded-full text-zinc-400 ring-1 ring-white/10 transition hover:bg-white/[0.06] hover:text-zinc-100"
      >
        <ChevronDown className={`size-4 transition-transform duration-300 ${collapsed ? '-rotate-90' : ''}`} />
      </button>
    </>
  )

  return (
    <Panel
      id={id}
      className={className}
      title="Needs your eyes"
      badge={queue.length + unnamed.count > 0 ? queue.length + unnamed.count : undefined}
      note={
        !queue.length
          ? `Every payee${period === 'all' ? '' : ` in ${period}`} is placed; ${plural(unnamed.count, 'payment')} without a name ${unnamed.count === 1 ? 'is' : 'are'} left.`
          : collapsed
            ? `${plural(queue.length, 'payee')} waiting${period === 'all' ? '' : ` in ${period}`} · ${inr(queue.reduce((s, g) => s + g.amount, 0))} across ${plural(queue.reduce((s, g) => s + g.count, 0), 'payment')}${unnamed.count ? ` · ${plural(unnamed.count, 'payment')} without a name` : ''}`
            : period === 'all'
              ? `${plural(queue.length, 'payee')} the app couldn't place with confidence. One answer fixes every payment to them, past and future.`
              : `${plural(queue.length, 'payee')} in ${period} the app couldn't place with confidence. One answer fixes every payment to them, in every year.`
      }
      actions={actions}
      flush
    >
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {/* long lists scroll inside the panel instead of stretching the page */}
            {unnamed.count > 0 && <UnnamedNotice count={unnamed.count} amount={unnamed.amount} onShow={onShowUnnamed} />}
            <div className="-mx-1 mt-4 max-h-[34rem] overflow-y-auto overscroll-contain px-1 [scrollbar-color:rgb(255_255_255/0.15)_transparent] [scrollbar-width:thin]">
              <ul className={`divide-y divide-white/[0.05] ${savingAll ? 'pointer-events-none opacity-60' : ''}`}>
                <AnimatePresence initial={false}>
                  {queue.slice(0, shown).map((g) => (
                    <ReviewRow
                      key={g.payee}
                      group={g}
                      tree={tree}
                      draft={draftOf(g)}
                      onDraft={(d) => setDraft(g.payee, d)}
                      onChanged={onChanged}
                      notify={notify}
                    />
                  ))}
                </AnimatePresence>
              </ul>
              {queue.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + PAGE)}
                  className="mt-2 mb-1 w-full rounded-xl py-2 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200"
                >
                  Show {Math.min(PAGE, queue.length - shown)} more of {queue.length - shown}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  )
}

/** Payments whose file doesn't say who was paid: many payees under one label, so not a row to answer once. */
function UnnamedNotice({ count, amount, onShow }: { count: number; amount: number; onShow: () => void }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-3.5 py-3 ring-1 ring-white/[0.08] ring-inset [background:repeating-linear-gradient(135deg,rgb(255_255_255/0.025)_0_6px,transparent_6px_12px)]">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-zinc-400 ring-1 ring-white/[0.06]">
        <CircleDashed className="size-4" />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm text-zinc-100">
          {plural(count, 'payment')} {count === 1 ? "doesn't" : "don't"} say who {count === 1 ? 'it' : 'they'} went to <span className="text-zinc-500 tabular-nums">· {inr(amount)}</span>
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
          The file they came from has no payee name, so they're different payees under one label and each needs its own answer.
        </p>
      </div>
      <button
        type="button"
        onClick={onShow}
        className="shrink-0 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
      >
        Show them
      </button>
    </div>
  )
}

function ReviewRow({
  group,
  tree,
  draft,
  onDraft,
  onChanged,
  notify,
}: {
  group: Group
  tree: CategoryNode[]
  draft: Draft
  onDraft: (d: Draft) => void
  onChanged: () => void
  notify: (text: string) => void
}) {
  const [saving, setSaving] = useState(false)
  const person = group.category === 'transfers.p2p'

  const save = async () => {
    setSaving(true)
    try {
      const res = await api.categorize({ payee: group.payee, category: draft.category, label: draft.label.trim() || undefined })
      if (res.savedAs === 'account') notify(`••${res.account} saved as one of your accounts · transfers to and from it are left out`)
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  return (
    <motion.li layout exit={{ opacity: 0, height: 0 }} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-zinc-400 ring-1 ring-white/[0.06]">
        {person ? <UserRound className="size-4" /> : <Store className="size-4" />}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm text-zinc-100" title={group.payee}>
          {group.payee}
        </p>
        <p className="truncate text-xs text-zinc-500 tabular-nums">
          {inr(group.amount)} · {group.count} payment{group.count === 1 ? '' : 's'} · {dayLabel(group.first)}
          {group.count > 1 && ` – ${dayLabel(group.last)}`}
          {group.elsewhere > 0 && (
            <span className="text-zinc-600" title="Your answer covers these too">
              {' '}
              · +{group.elsewhere} in other years
            </span>
          )}
        </p>
      </div>
      {person && (
        <input
          value={draft.label}
          onChange={(e) => onDraft({ ...draft, label: e.target.value })}
          placeholder="Who is this? e.g. Milk"
          className="w-40 rounded-full bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 outline-none placeholder:text-zinc-600 focus:ring-white/40"
        />
      )}
      <div className="w-48">
        <CategorySelect tree={tree} value={draft.category} onChange={(category) => onDraft({ ...draft, category })} />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
      >
        {draft.category === group.category && !draft.label.trim() ? 'Looks right' : 'Save'}
      </button>
    </motion.li>
  )
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* private window: fine, it just won't be remembered */
  }
}
