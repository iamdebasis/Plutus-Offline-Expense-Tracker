import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronDown, CircleAlert, CircleCheck, CircleDashed, CirclePause, FileArchive, FileSearch, FileSpreadsheet, FileText, Image as ImageIcon, Plus, Trash2, UserCheck, X,
} from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { formatBytes, formatDay, formatSpan, formatPeriod, plural } from '../lib/format'
import { inr, inrExact } from '../lib/money'
import { extOf, isImage } from '../lib/sources'
import type { CardStatement, HeldRow, Instrument, Transaction, UploadRecord } from '../types'
import { CardFace } from './CardFace'
import { PagePeek } from './PagePeek'
import { StartOver } from './StartOver'
import { StorageLine } from './StoragePanel'

interface Props {
  uploads: UploadRecord[]
  cards: Instrument[]
  /** Card statements you added: each file that is one shows what was read from it and whether it adds up. */
  statements?: CardStatement[]
  txns?: Transaction[]
  /** Shows a statement's rows in the transactions list. */
  onShowRows?: (upload: string, label: string) => void
  onDelete: (id: string) => void
  /** After you confirm or correct a statement on hold. */
  onChanged?: () => void
  showCards?: boolean
}

export function Vault({ uploads, cards, statements = [], txns = [], onShowRows, onDelete, onChanged, showCards = true }: Props) {
  if (!uploads.length) return null
  // a file's statements: one, or a year's download of several ("upl_x~1", "upl_x~2", …), in order
  const statementsOf = new Map<string, CardStatement[]>()
  for (const s of statements) {
    const upload = s.id.split('~')[0]
    statementsOf.set(upload, [...(statementsOf.get(upload) ?? []), s].sort((a, b) => (a.periodEnd ?? '').localeCompare(b.periodEnd ?? '')))
  }
  const held = statements.filter((s) => s.status === 'on_hold')
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="mt-16"
      id="your-vault"
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Your vault</h2>
        <p className="text-sm text-zinc-500">
          {plural(uploads.length, 'file')} · {plural(cards.length, 'card')}
        </p>
      </div>
      <StorageLine />
      {held.length > 0 && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-amber-400/[0.07] px-3 py-2 text-sm text-amber-100/90 ring-1 ring-amber-300/15">
          <CirclePause className="size-4 shrink-0 text-amber-300" />
          {held.length === 1 ? 'A statement is' : `${held.length} statements are`} on hold: read, but not proven by the bank's own figures, so
          nothing from {held.length === 1 ? 'it' : 'them'} is counted until you check {held.length === 1 ? 'it' : 'them'} below.
        </p>
      )}

      {showCards && cards.length > 0 && (
        <div className="-mx-1 mt-5 flex gap-3 overflow-x-auto px-1 pb-2">
          {cards.map((card, i) => (
            <CardFace key={card.id} card={card} delay={i * 0.05} className="w-[152px] shrink-0" />
          ))}
        </div>
      )}

      <ul className="mt-4 divide-y divide-white/[0.05]">
        {uploads.map((u) => (
          <VaultRow
            key={u.id}
            upload={u}
            statements={statementsOf.get(u.id) ?? []}
            card={cards.find((c) => c.id === statementsOf.get(u.id)?.[0]?.card)}
            txns={txns}
            onShowRows={onShowRows}
            onDelete={() => onDelete(u.id)}
            onChanged={onChanged}
          />
        ))}
      </ul>
      <StartOver />
    </motion.section>
  )
}

function VaultRow({
  upload,
  statements,
  card,
  txns,
  onShowRows,
  onDelete,
  onChanged,
}: {
  upload: UploadRecord
  statements: CardStatement[]
  card?: Instrument
  txns: Transaction[]
  onShowRows?: (upload: string, label: string) => void
  onDelete: () => void
  onChanged?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const statement = statements[0] as CardStatement | undefined
  const [open, setOpen] = useState(statements.some((s) => s.status === 'on_hold')) // a statement waiting for you starts open
  const d = upload.detection
  const ext = extOf(upload.originalName)
  const Icon = isImage(upload.originalName) ? ImageIcon : ext === 'zip' ? FileArchive : ['csv', 'xlsx', 'xls'].includes(ext) ? FileSpreadsheet : FileText
  const meta = [formatPeriod(d.period), formatBytes(upload.size), `added ${formatDay(upload.uploadedAt)}`].filter(Boolean).join(' · ')
  const cardName = statement ? `${card?.name ?? statement.issuer ?? 'Card'}${statement.last4 ? ` ••${statement.last4}` : ''}` : ''

  return (
    <li className="group py-3" onMouseLeave={() => setConfirming(false)}>
      <div className="flex items-center gap-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-zinc-400 ring-1 ring-white/[0.06]">
          <Icon className="size-4" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">{upload.originalName}</p>
          <p className="truncate text-xs text-zinc-500">
            <span className={d.kind === 'unknown' ? 'text-amber-300/90' : 'text-zinc-400'}>{d.label}</span> · {meta}
          </p>
        </div>
        {statement && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:bg-white/[0.05]"
          >
            {statements.length > 1 ? <ManyMarks statements={statements} /> : <CheckMark statement={statement} />}
            <ChevronDown className={`size-3.5 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
        <button
          type="button"
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
          aria-label={confirming ? `Confirm delete ${upload.originalName}` : `Delete ${upload.originalName}`}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs transition ${
            confirming
              ? 'bg-rose-400/15 text-rose-300'
              : 'text-zinc-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.05] hover:text-zinc-200'
          }`}
        >
          <Trash2 className="size-3.5" />
          {confirming && 'Delete?'}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {statement && open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {statements.map((s) =>
              s.status === 'on_hold' ? (
                <HeldReview key={s.id} statement={s} cardName={cardName} upload={upload} onChanged={onChanged} />
              ) : (
                <StatementCheck
                  key={s.id}
                  statement={s}
                  cardName={cardName}
                  rows={txns.filter((t) => t.sources.some((src) => src.upload === upload.id && (!s.pages.length || s.pages.includes(src.page ?? 0))))}
                  onShowRows={onShowRows && statements.length === 1 ? () => onShowRows(upload.id, `${cardName} statement`) : undefined}
                />
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

/** The check, written out: the statement's previous balance, minus the credits read, plus the charges read, against
 *  the total due the statement prints. A difference means a row was missed or misread; "Show these rows" opens
 *  them in the transactions list, to compare with the PDF. Your figures stay on your screen. */
function StatementCheck({
  statement: s,
  cardName,
  rows,
  onShowRows,
}: {
  statement: CardStatement
  cardName: string
  rows: Transaction[]
  onShowRows?: () => void
}) {
  const credits = rows.filter((t) => t.direction === 'credit').length
  const debits = rows.length - credits
  const result = s.previousBalance !== null ? s.previousBalance - s.credits + s.debits : null
  const period = s.periodStart && s.periodEnd ? formatSpan(s.periodStart, s.periodEnd) : 'this statement'
  const button = onShowRows && (
    <button
      type="button"
      onClick={onShowRows}
      className="mt-3 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
    >
      Show these {plural(rows.length, 'row')}
    </button>
  )
  if (byTotals(s))
    return (
      <div className="mt-3 ml-13 rounded-2xl bg-white/[0.025] px-4 py-3.5 ring-1 ring-white/[0.06]">
        <p className="text-sm text-zinc-200">
          {cardName} · {period}
        </p>
        <TotalsCheck statement={s} rows={{ debits, credits }} />
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          {s.status === 'confirmed' && 'You checked these rows and confirmed them. '}
          {s.check === 'matched' &&
            'Every row is accounted for: it prints no balances, but the rows read come to its own totals of purchases and of payments, to the paisa.'}
          {s.check === 'mismatch' &&
            `${inr(Math.abs(s.difference ?? 0))} apart: a row was missed or read wrongly. Compare the rows with your PDF; the one that's missing or different is the cause.`}
        </p>
        {button}
      </div>
    )
  if (s.kind === 'export' && s.check === 'unchecked')
    return (
      <div className="mt-3 ml-13 rounded-2xl bg-white/[0.025] px-4 py-3.5 ring-1 ring-white/[0.06]">
        <p className="text-sm text-zinc-200">
          {cardName} · {period}
        </p>
        <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm tabular-nums">
          <dt className="text-zinc-400">
            Purchases and charges <span className="text-xs text-zinc-600">{plural(debits, 'row')} read</span>
          </dt>
          <dd className="text-right text-zinc-200">{inrExact(s.debits)}</dd>
          <dt className="text-zinc-400">
            Payments, refunds, cashback <span className="text-xs text-zinc-600">{plural(credits, 'row')} read</span>
          </dt>
          <dd className="text-right text-zinc-200">{inrExact(s.credits)}</dd>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          The card's transactions over a span, exported from your bank: there are no totals to check the rows against. Purchases a
          statement of yours also lists are counted once, and a bill for a cycle this export lists whole adds no estimate.
        </p>
        {button}
      </div>
    )
  return (
    <div className="mt-3 ml-13 rounded-2xl bg-white/[0.025] px-4 py-3.5 ring-1 ring-white/[0.06]">
      <p className="text-sm text-zinc-200">
        {cardName} · {period}
        {s.dueDate && <span className="text-zinc-500"> · due {formatDay(s.dueDate)}</span>}
      </p>
      <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm tabular-nums">
        <dt className="text-zinc-400">Previous balance <span className="text-xs text-zinc-600">as printed</span></dt>
        <dd className="text-right text-zinc-200">{s.previousBalance !== null ? inrExact(s.previousBalance) : 'not found'}</dd>
        <dt className="text-zinc-400">
          − Payments, refunds, cashback <span className="text-xs text-zinc-600">{plural(credits, 'row')} read</span>
        </dt>
        <dd className="text-right text-zinc-200">{inrExact(s.credits)}</dd>
        <dt className="text-zinc-400">
          + Purchases and charges <span className="text-xs text-zinc-600">{plural(debits, 'row')} read</span>
        </dt>
        <dd className="text-right text-zinc-200">{inrExact(s.debits)}</dd>
        <dt className="border-t border-white/[0.06] pt-1.5 text-zinc-300">= Total due, by the rows read</dt>
        <dd className="border-t border-white/[0.06] pt-1.5 text-right text-zinc-100">{result !== null ? inrExact(result) : '—'}</dd>
        <dt className="text-zinc-400">Total due <span className="text-xs text-zinc-600">as printed</span></dt>
        <dd className="text-right text-zinc-200">{s.totalDue !== null ? inrExact(s.totalDue) : 'not found'}</dd>
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-zinc-500">
        {s.status === 'confirmed' && 'You checked these rows and confirmed them. '}
        {s.status === 'agreed' && "Nothing on it to check the rows against, but two independent readings (the rules and the local AI) found the same rows. "}
        {s.check === 'matched' && 'Every row is accounted for: the rows read add up to the total the bank printed.'}
        {s.check === 'mismatch' &&
          `${inr(Math.abs(s.difference ?? 0))} apart: a row was missed or read wrongly, or a figure above was. Compare the rows with your PDF; the one that's missing or different is the cause.`}
        {s.check === 'unchecked' &&
          "This statement doesn't print a previous balance or total due (exports from a bank's app often don't), so its rows can't be checked against them."}
      </p>
      {s.unread.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-zinc-400">
            {plural(s.unread.length, 'line')} in the table {s.unread.length === 1 ? "wasn't" : "weren't"} read as a row
            {s.check === 'mismatch' ? ' (the missing row is likely among them)' : ' (totals and notes look like this too)'}:
          </p>
          <ul className="mt-1.5 space-y-0.5 rounded-xl bg-black/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-400">
            {s.unread.map((line, i) => (
              <li key={i} className="truncate" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {button}
    </div>
  )
}

/** A statement with no balances (a year's summary) is checked against its own totals instead: the debits and the
 *  credits read, each beside the total the bank printed. */
function byTotals(s: CardStatement): boolean {
  return (s.previousBalance === null || s.totalDue === null) && s.printedDebits !== null && s.printedCredits !== null
}

/** `rows`: how many debits and credits were read, or none for the rows listed below. */
function TotalsCheck({ statement: s, rows }: { statement: CardStatement; rows?: { debits: number; credits: number } }) {
  const read = (n: number | undefined) => (n === undefined ? 'rows below' : `${plural(n, 'row')} read`)
  return (
    <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm tabular-nums">
      <dt className="text-zinc-400">
        Purchases and charges <span className="text-xs text-zinc-600">{read(rows?.debits)}</span>
      </dt>
      <dd className="text-right text-zinc-200">{inrExact(s.debits)}</dd>
      <dt className="text-zinc-400">
        Purchases and charges <span className="text-xs text-zinc-600">as printed</span>
      </dt>
      <dd className="text-right text-zinc-200">{inrExact(s.printedDebits ?? 0)}</dd>
      <dt className="border-t border-white/[0.06] pt-1.5 text-zinc-400">
        Payments, refunds, cashback <span className="text-xs text-zinc-600">{read(rows?.credits)}</span>
      </dt>
      <dd className="border-t border-white/[0.06] pt-1.5 text-right text-zinc-200">{inrExact(s.credits)}</dd>
      <dt className="text-zinc-400">
        Payments, refunds, cashback <span className="text-xs text-zinc-600">as printed</span>
      </dt>
      <dd className="text-right text-zinc-200">{inrExact(s.printedCredits ?? 0)}</dd>
    </dl>
  )
}

/** A file of several statements (a year's download): how many, and how many add up or wait for you. */
function ManyMarks({ statements }: { statements: CardStatement[] }) {
  const held = statements.filter((s) => s.status === 'on_hold').length
  const fine = statements.length - held
  return (
    <>
      {held ? (
        <CirclePause className="size-3.5 shrink-0 text-[var(--color-status-warning)]" />
      ) : (
        <CircleCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" />
      )}
      {statements.length} statements{held ? ` · ${held} on hold` : ''}
      {held && fine ? ` · ${fine} counted` : ''}
    </>
  )
}

function CheckMark({ statement: s }: { statement: CardStatement }) {
  if (s.status === 'on_hold')
    return (
      <>
        <CirclePause className="size-3.5 shrink-0 text-[var(--color-status-warning)]" /> On hold
      </>
    )
  if (s.status === 'confirmed')
    return (
      <>
        <UserCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" /> Confirmed by you
      </>
    )
  if (s.status === 'agreed')
    return (
      <>
        <CircleCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" /> Two readings agree
      </>
    )
  if (s.status === 'exact' && s.check !== 'matched')
    return (
      <>
        <CircleCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" /> Read from its cells
      </>
    )
  if (s.check === 'matched' || (s.status === 'proven' && s.check === 'unchecked'))
    return (
      <>
        <CircleCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" /> Adds up
      </>
    )
  if (s.check === 'mismatch')
    return (
      <>
        <CircleAlert className="size-3.5 shrink-0 text-[var(--color-status-warning)]" /> {inr(Math.abs(s.difference ?? 0))} apart
      </>
    )
  return (
    <>
      <CircleDashed className="size-3.5 shrink-0 text-zinc-500" /> {s.kind === 'export' ? 'Export' : 'Not checked'}
    </>
  )
}

interface Draft {
  day: string // YYYY-MM-DD
  time: string // HH:MM, or ""
  description: string
  amount: string
  credit: boolean
  page: number
  y: number | null
}

const toDraft = (t: Transaction): Draft => ({
  day: t.at.slice(0, 10),
  time: t.at.slice(11, 16) === '00:00' ? '' : t.at.slice(11, 16),
  description: t.note || t.payee,
  amount: t.amount.toFixed(2),
  credit: t.direction === 'credit',
  page: t.sources[0]?.page ?? 1,
  y: t.sources[0]?.y ?? null,
})

/** A statement on hold: why, the arithmetic, its rows as read (see where each is printed, fix, add or remove one), and
 *  one click to count them. Nothing from it is counted until then; your corrections are checked against the bank's
 *  figures again as soon as they're saved. */
function HeldReview({ statement: s, cardName, upload, onChanged }: { statement: CardStatement; cardName: string; upload: UploadRecord; onChanged?: () => void }) {
  const [rows, setRows] = useState<Draft[]>(() => s.held.map(toDraft))
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [peek, setPeek] = useState<{ page: number; y: number | null } | null>(null)
  const period = s.periodStart && s.periodEnd ? formatSpan(s.periodStart, s.periodEnd) : 'this statement'
  const result = s.previousBalance !== null ? s.previousBalance - s.credits + s.debits : null
  const adds = s.check === 'matched'

  const set = (i: number, patch: Partial<Draft>) => setRows((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const valid = rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && Number(r.amount) > 0 && r.description.trim())

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload: HeldRow[] = rows.map((r) => ({
        at: `${r.day}T${r.time || '00:00'}:00+05:30`,
        amount: Math.round(Number(r.amount) * 100) / 100,
        direction: r.credit ? 'credit' : 'debit',
        description: r.description.trim(),
        page: r.page,
      }))
      await api.correctHeld(s.id, payload)
      setEditing(false)
      onChanged?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.confirmHeld(s.id)
      onChanged?.()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 ml-13 rounded-2xl bg-amber-400/[0.03] px-4 py-3.5 ring-1 ring-amber-300/15">
      <p className="text-sm text-zinc-200">
        {cardName} · {period}
        {s.dueDate && <span className="text-zinc-500"> · due {formatDay(s.dueDate)}</span>}
      </p>
      <p className="mt-1.5 text-sm text-amber-100/90">
        On hold: {s.proof || "its rows couldn't be proven"}. Nothing from it is counted until you check it.
      </p>

      {byTotals(s) && <TotalsCheck statement={s} />}
      {s.previousBalance !== null && s.totalDue !== null && (
        <dl className="mt-3 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm tabular-nums">
          <dt className="text-zinc-400">Previous balance <span className="text-xs text-zinc-600">as printed</span></dt>
          <dd className="text-right text-zinc-200">{inrExact(s.previousBalance)}</dd>
          <dt className="text-zinc-400">− Payments, refunds, cashback <span className="text-xs text-zinc-600">rows below</span></dt>
          <dd className="text-right text-zinc-200">{inrExact(s.credits)}</dd>
          <dt className="text-zinc-400">+ Purchases and charges <span className="text-xs text-zinc-600">rows below</span></dt>
          <dd className="text-right text-zinc-200">{inrExact(s.debits)}</dd>
          <dt className="border-t border-white/[0.06] pt-1.5 text-zinc-300">= Total due, by these rows</dt>
          <dd className="border-t border-white/[0.06] pt-1.5 text-right text-zinc-100">{result !== null ? inrExact(result) : '—'}</dd>
          <dt className="text-zinc-400">Total due <span className="text-xs text-zinc-600">as printed</span></dt>
          <dd className="text-right text-zinc-200">{inrExact(s.totalDue)}</dd>
        </dl>
      )}
      <p className={`mt-2 text-xs ${adds ? 'text-[var(--color-status-good)]' : 'text-zinc-500'}`}>
        {adds
          ? byTotals(s)
            ? 'These rows come to the totals the bank printed. Count them when they look right to you.'
            : 'These rows add up to the total the bank printed. Count them when they look right to you.'
          : (s.previousBalance !== null && s.totalDue !== null) || byTotals(s)
            ? `${inr(Math.abs(s.difference ?? 0))} apart. Compare the rows with the statement (the page icon shows where each is printed): fix, add or remove the one that's off.`
            : 'Compare them with the file (the page icon shows where each is printed), then count them.'}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="py-1 pr-3 font-normal">Date</th>
              <th className="py-1 pr-3 font-normal">As printed</th>
              <th className="py-1 pr-3 text-right font-normal">Amount</th>
              <th className="py-1 pr-3 font-normal">Type</th>
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-white/[0.04]">
                <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-300">
                  {editing ? (
                    <input type="date" value={r.day} onChange={(e) => set(i, { day: e.target.value })} className="rounded-md bg-black/30 px-1.5 py-0.5 text-zinc-100 ring-1 ring-white/10" />
                  ) : (
                    formatDay(r.day)
                  )}
                </td>
                <td className="max-w-[260px] py-1.5 pr-3 text-zinc-200">
                  {editing ? (
                    <input value={r.description} onChange={(e) => set(i, { description: e.target.value })} aria-label="Description" className="w-full rounded-md bg-black/30 px-1.5 py-0.5 text-zinc-100 ring-1 ring-white/10" />
                  ) : (
                    <span className="block truncate" title={r.description}>
                      {r.description}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right text-zinc-100">
                  {editing ? (
                    <input inputMode="decimal" value={r.amount} onChange={(e) => set(i, { amount: e.target.value.replace(/[^\d.]/g, '') })} aria-label="Amount" className="w-24 rounded-md bg-black/30 px-1.5 py-0.5 text-right text-zinc-100 ring-1 ring-white/10" />
                  ) : (
                    inrExact(Number(r.amount))
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {editing ? (
                    <button type="button" onClick={() => set(i, { credit: !r.credit })} className="rounded-full px-2 py-0.5 text-xs ring-1 ring-white/15 hover:bg-white/[0.06]">
                      {r.credit ? 'Credit' : 'Debit'}
                    </button>
                  ) : (
                    <span className={`text-xs ${r.credit ? 'text-emerald-300/90' : 'text-zinc-400'}`}>{r.credit ? 'Credit' : 'Debit'}</span>
                  )}
                </td>
                <td className="py-1.5 text-right whitespace-nowrap">
                  <button type="button" onClick={() => setPeek({ page: r.page, y: r.y })} aria-label={`Show where ${r.description} is printed`} title="Show where it's printed"
                    className="rounded-full p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">
                    <FileSearch className="size-3.5" />
                  </button>
                  {editing && (
                    <button type="button" onClick={() => setRows((all) => all.filter((_, j) => j !== i))} aria-label={`Remove ${r.description}`}
                      className="rounded-full p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-rose-300">
                      <X className="size-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {s.unread.length > 0 && (
        <div className="mt-3">
          <p className="text-xs text-zinc-400">
            {plural(s.unread.length, 'line')} with an amount {s.unread.length === 1 ? "wasn't" : "weren't"} read as a row (a missing row may be among them):
          </p>
          <ul className="mt-1.5 space-y-0.5 rounded-xl bg-black/20 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-400">
            {s.unread.map((line, i) => (
              <li key={i} className="truncate" title={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button type="button" onClick={() => setRows((all) => [...all, { day: s.periodEnd ?? s.statementDate ?? new Date().toISOString().slice(0, 10), time: '', description: '', amount: '', credit: false, page: 1, y: null }])}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-zinc-300 ring-1 ring-white/10 hover:bg-white/[0.05]">
              <Plus className="size-3.5" /> Add a row
            </button>
            <button type="button" disabled={busy || !valid} onClick={save}
              className="rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-40">
              Save and check again
            </button>
            <button type="button" onClick={() => { setRows(s.held.map(toDraft)); setEditing(false) }} className="rounded-full px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
              Cancel
            </button>
          </>
        ) : confirming ? (
          <>
            <span className="text-sm text-zinc-300">Count these {plural(rows.length, 'row')} as your spending?</span>
            <button type="button" disabled={busy} onClick={confirm} className="rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-40">
              Yes, count them
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded-full px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
              Not yet
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirming(true)} className="rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-900">
              They're right: count them
            </button>
            <button type="button" onClick={() => setEditing(true)} className="rounded-full px-3 py-1.5 text-sm text-zinc-300 ring-1 ring-white/10 hover:bg-white/[0.05]">
              Fix a row
            </button>
          </>
        )}
      </div>
      {peek && <PagePeek url={api.uploadFile(upload.id)} name={upload.originalName} page={peek.page} y={peek.y} onClose={() => setPeek(null)} />}
    </div>
  )
}

