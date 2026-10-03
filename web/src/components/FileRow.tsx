import { motion } from 'motion/react'
import { AlertCircle, Check, ChevronDown, Copy, FileArchive, FileCode2, FileText, FolderOpen, KeyRound, Lock, Trash2 } from 'lucide-react'
import { forwardRef } from 'react'
import { formatBytes, formatDay, formatPeriod, plural } from '../lib/format'
import { KIND_LABEL, extOf, isPdf } from '../lib/sources'
import type { Item, Phase } from '../lib/useSelection'
import type { DeclaredKind } from '../types'

interface Props {
  item: Item
  phase: Phase
  onRemove: () => void
  onKind: (kind: DeclaredKind) => void
  onPassword: (password: string) => void
}

export const FileRow = forwardRef<HTMLDivElement, Props>(function FileRow({ item, phase, onRemove, onKind, onPassword }, ref) {
  // files waiting for the next run can still be changed or dropped
  const editable = phase === 'select' || item.status === 'ready' || item.status === 'known'
  const needsPassword = item.locked && (item.status === 'ready' || item.status === 'error')

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className="group flex items-start gap-4 rounded-2xl px-3 py-3 transition-colors hover:bg-white/[0.025]"
    >
      <Thumb item={item} />

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-[14.5px] text-zinc-100" title={item.file.name}>
            {item.file.name}
          </p>
          {editable && item.status !== 'known' && !item.folder && <KindSelect value={item.kind} onChange={onKind} disabled={item.kind === 'screenshot'} />}
          {editable && (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${item.file.name}`}
              className="-mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-rose-400/10 hover:text-rose-300"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
        <Meta item={item} />
        {needsPassword && (
          <PasswordField
            value={item.password ?? ''}
            onChange={onPassword}
            wrong={item.error?.code === 'wrong_password'}
            disabled={phase === 'processing'}
          />
        )}
      </div>
    </motion.div>
  )
})

function Meta({ item }: { item: Item }) {
  const base = item.folder
    ? `Folder · ${plural(item.folder.files.length, 'Google Pay file')} · ${formatBytes(item.folder.bytes)}`
    : [formatBytes(item.file.size), item.pages ? plural(item.pages, 'page') : null].filter(Boolean).join(' · ')

  if (item.status === 'uploading') {
    const reading = item.progress >= 1
    return (
      <div className="mt-2 flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className={`h-full rounded-full transition-[width] duration-300 ease-out ${reading ? 'shimmer w-full' : 'bg-white'}`}
            style={reading ? undefined : { width: `${Math.max(6, item.progress * 100)}%` }}
          />
        </div>
        <span className="w-20 text-right text-xs text-zinc-500 tabular-nums">{reading ? 'Identifying…' : item.progress ? `${Math.round(item.progress * 100)}%` : 'Queued'}</span>
      </div>
    )
  }
  if (item.status === 'error' && item.error) {
    return <p className="mt-1 text-[13px] text-rose-300">{item.error.message}</p>
  }
  if (item.status === 'known' && item.knownAs) {
    const { name, uploadedAt, inList } = item.knownAs
    const same = name === item.file.name
    return (
      <p className="mt-1 truncate text-[13px] text-sky-300" title={name}>
        {inList
          ? `Same file as “${name}” above · skipped`
          : `Added before${uploadedAt ? ` on ${formatDay(uploadedAt)}` : ''}${same ? '' : ` as “${name}”`} · skipped`}
      </p>
    )
  }
  if (item.status === 'duplicate' && item.result) {
    return <p className="mt-1 truncate text-[13px] text-sky-300">Already in your vault · added {formatDay(item.result.uploadedAt)}</p>
  }
  if ((item.status === 'importing' || item.status === 'done') && item.result) {
    const d = item.result.detection
    const imp = item.result.importStatus
    const extra = [formatPeriod(d.period), d.pages ? plural(d.pages, 'page') : null, item.result.unlocked ? 'unlocked' : null]
      .filter(Boolean)
      .join(' · ')
    return (
      <div className="mt-1 min-w-0 text-[13px]">
        <p className="truncate">
          <span className={d.kind === 'unknown' ? 'text-amber-300' : 'text-emerald-300'}>{d.label}</span>
          {extra && <span className="text-zinc-500"> · {extra}</span>}
        </p>
        {item.status === 'importing' ? (
          <div className="mt-2 flex items-center gap-3">
            <div className="shimmer h-1 w-24 shrink-0 rounded-full" />
            <span className="truncate text-xs text-zinc-400">{imp?.step ?? 'Waiting its turn'}…</span>
          </div>
        ) : (
          imp && <ImportSummary status={imp} kind={d.kind} />
        )}
      </div>
    )
  }
  return (
    <p className="mt-1 text-[13px] text-zinc-500">
      {base}
      {item.locked && <span className="text-amber-300/90"> · password protected</span>}
    </p>
  )
}

function ImportSummary({ status, kind }: { status: NonNullable<NonNullable<Item['result']>['importStatus']>; kind: string }) {
  if (status.state === 'skipped') return <p className="mt-1 text-xs leading-snug text-amber-300/90">{status.error}</p>
  const noun = kind === 'cred_history' ? 'card payment' : 'transaction'
  const parts = [
    status.added ? `${plural(status.added, `new ${noun}`)}` : `no new ${noun}s`,
    status.duplicates ? `${status.duplicates} already known` : null,
    status.needsReview ? `${plural(status.needsReview, 'payee')} to review` : null,
  ].filter(Boolean)
  return (
    <>
      <p className="mt-1 text-xs text-zinc-400">
        {parts.join(' · ')}
        {status.method && !['text', 'export'].includes(status.method) && <span className="text-zinc-600"> · read via {METHOD[status.method] ?? status.method}</span>}
      </p>
      {/* an export with many parts says what each held and what became of it */}
      {status.details && status.details.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 border-l border-white/10 pl-2.5 text-[11.5px] leading-snug text-zinc-500">
          {status.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </>
  )
}

const METHOD: Record<string, string> = { decoded: 'decoded text + OCR check', ocr: 'on-device OCR', 'vision-model': 'local AI' }

function Thumb({ item }: { item: Item }) {
  const ext = extOf(item.file.name)
  const Icon = item.folder ? FolderOpen : ext === 'zip' ? FileArchive : ext === 'html' || ext === 'htm' || ext === 'json' || ext === 'csv' ? FileCode2 : FileText
  const loadingPdf = isPdf(item.file.name) && !item.preview && item.pages === undefined && !item.locked

  return (
    <div className="relative shrink-0">
      <div className="flex h-[58px] w-[46px] items-center justify-center overflow-hidden rounded-lg bg-white/[0.05] ring-1 ring-white/10">
        {item.preview ? (
          <img src={item.preview} alt="" className="h-full w-full object-cover object-top" />
        ) : loadingPdf ? (
          <div className="shimmer h-full w-full" />
        ) : item.locked ? (
          <Lock className="size-5 text-amber-300/80" />
        ) : (
          <Icon className="size-5 text-zinc-400" strokeWidth={1.6} />
        )}
      </div>
      <StatusBadge item={item} />
    </div>
  )
}

function StatusBadge({ item }: { item: Item }) {
  const ring = 'absolute -right-1.5 -bottom-1.5 flex size-5 items-center justify-center rounded-full ring-[2.5px] ring-panel'
  switch (item.status) {
    case 'uploading':
    case 'importing':
      return (
        <span className={`${ring} bg-zinc-800`}>
          <span className="size-3 animate-spin rounded-full border-[1.5px] border-white/25 border-t-white" />
        </span>
      )
    case 'done':
      return (
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }} className={`${ring} bg-emerald-400 text-emerald-950`}>
          <Check className="size-3" strokeWidth={3.2} />
        </motion.span>
      )
    case 'duplicate':
    case 'known':
      return (
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className={`${ring} bg-sky-400 text-sky-950`}>
          <Copy className="size-2.5" strokeWidth={3} />
        </motion.span>
      )
    case 'error':
      return (
        <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className={`${ring} bg-rose-400 text-rose-950`}>
          <AlertCircle className="size-3" strokeWidth={3} />
        </motion.span>
      )
    default:
      return null
  }
}

function KindSelect({ value, onChange, disabled }: { value: DeclaredKind; onChange: (k: DeclaredKind) => void; disabled?: boolean }) {
  return (
    <label className="relative shrink-0" title="What kind of file is this? Auto-detect usually gets it right.">
      <span className="sr-only">File type</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as DeclaredKind)}
        className="cursor-pointer appearance-none rounded-full bg-white/[0.05] py-1 pr-7 pl-3 text-xs text-zinc-300 ring-1 ring-white/10 transition outline-none hover:bg-white/[0.08] focus-visible:ring-white/40 disabled:cursor-default disabled:opacity-70"
      >
        {(Object.keys(KIND_LABEL) as DeclaredKind[]).map((k) => (
          <option key={k} value={k} className="bg-zinc-900">
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {!disabled && <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-zinc-500" />}
    </label>
  )
}

function PasswordField({ value, onChange, wrong, disabled }: { value: string; onChange: (v: string) => void; wrong: boolean; disabled: boolean }) {
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
      <label
        className={`mt-2.5 flex items-center gap-2 rounded-xl bg-white/[0.04] px-3 py-2 ring-1 transition focus-within:ring-white/40 ${
          wrong ? 'ring-rose-400/50' : 'ring-white/10'
        }`}
      >
        <KeyRound className="size-4 shrink-0 text-amber-300/80" />
        <input
          type="password"
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
          placeholder="Statement password"
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </label>
      <p className="mt-1.5 text-xs text-zinc-500">Used once to unlock the file, never saved. Banks usually send the format in the statement email.</p>
    </motion.div>
  )
}
