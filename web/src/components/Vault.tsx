import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, FileArchive, FileSpreadsheet, FileText, Image as ImageIcon, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { formatBytes, formatDay, formatPeriod, plural } from '../lib/format'
import { inr, inrExact } from '../lib/money'
import { extOf, isImage } from '../lib/sources'
import type { CardStatement, Instrument, Transaction, UploadRecord } from '../types'
import { CardFace } from './CardFace'
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
  showCards?: boolean
}

export function Vault({ uploads, cards, statements = [], txns = [], onShowRows, onDelete, showCards = true }: Props) {
  if (!uploads.length) return null
  const statementOf = new Map(statements.map((s) => [s.id, s]))
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="mt-16"
    >
      <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3">
        <h2 className="font-display text-lg font-semibold tracking-tight">Your vault</h2>
        <p className="text-sm text-zinc-500">
          {plural(uploads.length, 'file')} · {plural(cards.length, 'card')}
        </p>
      </div>
      <StorageLine />

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
            statement={statementOf.get(u.id)}
            card={cards.find((c) => c.id === statementOf.get(u.id)?.card)}
            txns={txns}
            onShowRows={onShowRows}
            onDelete={() => onDelete(u.id)}
          />
        ))}
      </ul>
    </motion.section>
  )
}

function VaultRow({
  upload,
  statement,
  card,
  txns,
  onShowRows,
  onDelete,
}: {
  upload: UploadRecord
  statement?: CardStatement
  card?: Instrument
  txns: Transaction[]
  onShowRows?: (upload: string, label: string) => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [open, setOpen] = useState(false)
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
            <CheckMark statement={statement} />
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
            <StatementCheck
              statement={statement}
              cardName={cardName}
              rows={txns.filter((t) => t.sources.some((s) => s.upload === upload.id))}
              onShowRows={onShowRows ? () => onShowRows(upload.id, `${cardName} statement`) : undefined}
            />
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
  const period = s.periodStart && s.periodEnd ? `${formatDay(s.periodStart)} – ${formatDay(s.periodEnd)}` : 'this statement'
  const button = onShowRows && (
    <button
      type="button"
      onClick={onShowRows}
      className="mt-3 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
    >
      Show these {plural(rows.length, 'row')}
    </button>
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

function CheckMark({ statement: s }: { statement: CardStatement }) {
  if (s.check === 'matched')
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
