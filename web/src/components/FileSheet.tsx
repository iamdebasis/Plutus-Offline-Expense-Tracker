import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Copy, FolderPlus, Plus, RotateCw, X } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { formatBytes, plural, shortPath } from '../lib/format'
import { instrumentId } from '../lib/issuers'
import { useStorage } from '../lib/storage'
import { FILE_KIND_NOUN } from '../lib/sources'
import type { Item, Phase } from '../lib/useSelection'
import type { CardRef, DeclaredKind, FileKind } from '../types'
import { CardFace } from './CardFace'
import { FileRow } from './FileRow'
import { StoragePanel } from './StoragePanel'

interface Props {
  open: boolean
  items: Item[]
  phase: Phase
  knownCardIds: Set<string>
  onClose: () => void
  onClear: () => void
  onAddMore: () => void
  /** Add an export's extracted folder (Google Takeout) instead of a file. */
  onAddFolder: () => void
  onProcess: () => void
  onDone: () => void
  onRemove: (id: string) => void
  onKind: (id: string, kind: DeclaredKind) => void
  onPassword: (id: string, password: string) => void
  notify: (text: string) => void
}

export function FileSheet(props: Props) {
  const { open, items, phase, onClose } = props
  const known = items.filter((i) => i.status === 'known')

  // Closing never stops anything: reading carries on in the background and shows at the top of the page.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

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
            aria-labelledby="sheet-title"
            initial={{ y: 28, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 18, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 32 }}
            className="relative flex max-h-[88dvh] w-full max-w-[600px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-panel/95 shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            <SheetHeader {...props} />
            <StoragePanel />
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
              {phase === 'select' && known.length > 0 && <KnownBanner count={known.length} total={items.length} />}
              <AnimatePresence initial={false} mode="popLayout">
                {items.map((item) => (
                  <FileRow
                    key={item.id}
                    item={item}
                    phase={phase}
                    onRemove={() => props.onRemove(item.id)}
                    onKind={(k) => props.onKind(item.id, k)}
                    onPassword={(p) => props.onPassword(item.id, p)}
                  />
                ))}
              </AnimatePresence>
            </div>
            {phase === 'done' && <Summary items={items} knownCardIds={props.knownCardIds} />}
            <SheetFooter {...props} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function SheetHeader({ items, phase, onClose }: Props) {
  const storage = useStorage()
  const known = items.filter((i) => i.status === 'known').length
  const sendable = items.filter((i) => i.status !== 'known')
  const total = sendable.reduce((sum, i) => sum + (i.folder?.bytes ?? i.file.size), 0)
  const inRun = items.filter((i) => i.status !== 'ready' && i.status !== 'known')
  const finished = inRun.filter((i) => ['done', 'duplicate', 'error'].includes(i.status)).length
  const saved = items.filter((i) => i.status === 'done').length
  const failed = items.filter((i) => i.status === 'error').length
  const repeats = items.filter((i) => i.status === 'duplicate').length + known

  const title =
    phase === 'select'
      ? `${plural(items.length, 'file')} selected`
      : phase === 'processing'
        ? `Reading ${plural(inRun.length, 'file')}…`
        : failed
          ? `${saved} saved, ${failed} need attention`
          : saved
            ? `${plural(saved, 'file')} added to your vault`
            : 'Nothing new to add'

  const where = storage ? shortPath(storage.display, 40) : 'your folder'
  const subtitle =
    phase === 'select'
      ? known === items.length
        ? 'All of these were added before'
        : `${formatBytes(total)}${known ? ` · ${known} added before, will be skipped` : ''} · check the list, then process`
      : phase === 'processing'
        ? `${finished} of ${inRun.length} done · you can close this, reading carries on`
        : saved
          ? `Kept in ${where}, sorted by type${repeats ? ` · ${repeats} already there` : ''}`
          : `${repeats === 1 ? 'This file is' : 'These files are'} already in your vault`

  return (
    <div className="relative">
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <h2 id="sheet-title" className="font-display text-[19px] font-semibold tracking-tight">
            {title}
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={phase === 'processing' ? 'Close; reading carries on in the background' : 'Close'}
          className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30"
        >
          <X className="size-5" />
        </button>
      </div>
      {phase === 'processing' && (
        <div className="absolute inset-x-0 bottom-0 h-px bg-white/[0.06]">
          <motion.div
            className="h-full bg-gradient-to-r from-sky-300 to-violet-300"
            animate={{ width: `${(finished / Math.max(inRun.length, 1)) * 100}%` }}
            transition={{ ease: 'easeOut' }}
          />
        </div>
      )}
    </div>
  )
}

function Summary({ items, knownCardIds }: { items: Item[]; knownCardIds: Set<string> }) {
  const { counts, cards } = useMemo(() => {
    const counts = new Map<FileKind, number>()
    const cards = new Map<string, CardRef>()
    for (const item of items) {
      if (item.status !== 'done' || !item.result) continue
      const d = item.result.detection
      counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1)
      for (const card of d.cards) {
        // the same card can show up in a CRED history and a statement; keep what each one knows
        const id = instrumentId(card.issuer, card.last4)
        const seen = cards.get(id)
        cards.set(id, seen ? { ...seen, product: seen.product ?? card.product, network: seen.network ?? card.network } : card)
      }
    }
    return { counts, cards: [...cards.entries()] }
  }, [items])

  if (!counts.size) return null
  const line = [...counts.entries()].map(([kind, n]) => `${n} ${FILE_KIND_NOUN[kind][n === 1 ? 0 : 1]}`).join(' · ')
  const fresh = cards.filter(([id]) => !knownCardIds.has(id)).length

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="px-6 pb-4">
      <div className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.06]">
        <p className="text-sm text-zinc-300">{line}</p>
        {cards.length > 0 && (
          <>
            <p className="mt-4 text-[11px] font-medium tracking-[0.12em] text-zinc-500 uppercase">
              {fresh ? `${plural(fresh, 'new card')} found` : 'Cards in these files'}
            </p>
            <div className="-mx-1 mt-3 flex gap-3 overflow-x-auto px-1 pb-1">
              {cards.map(([id, card], i) => (
                <CardFace
                  key={id}
                  card={card}
                  delay={0.15 + i * 0.07}
                  className="w-[136px] shrink-0"
                  badge={!knownCardIds.has(id) ? <span className="rounded-full bg-white/20 px-1.5 py-px text-[9px] font-semibold tracking-wider uppercase backdrop-blur">New</span> : undefined}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </motion.div>
  )
}

function SheetFooter({ items, phase, onClose, onClear, onAddMore, onAddFolder, onProcess, onDone }: Props) {
  const locked = items.filter((i) => i.locked && !i.password && (i.status === 'ready' || i.status === 'error')).length
  const retryable = items.filter((i) => i.status === 'error').length
  const ready = items.filter((i) => i.status === 'ready').length
  const hint =
    phase === 'processing'
      ? ''
      : locked > 0
        ? `${plural(locked, 'file')} need${locked === 1 ? 's' : ''} a password`
        : ''

  return (
    <div className="flex items-center gap-2 border-t border-white/[0.06] bg-black/20 px-4 py-4 sm:gap-3 sm:px-5">
      {phase === 'select' && (
        <button type="button" onClick={onClear} className="shrink-0 rounded-full px-3 py-2 text-sm text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-100 sm:px-4">
          Clear
        </button>
      )}
      <p className="min-w-0 flex-1 truncate text-xs text-amber-300/90">{hint}</p>
      {phase !== 'processing' && (
        <button
          type="button"
          onClick={onAddMore}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-4 py-2 text-sm whitespace-nowrap text-zinc-200 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
        >
          <Plus className="size-4" /> Add<span className="hidden sm:inline"> more</span>
        </button>
      )}
      {phase !== 'processing' && (
        <button
          type="button"
          onClick={onAddFolder}
          title="Add a folder: your Google Pay export from Google Takeout, unzipped"
          aria-label="Add a folder: your Google Pay export from Google Takeout, unzipped"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300 ring-1 ring-white/10 transition hover:bg-white/[0.1] hover:text-zinc-100"
        >
          <FolderPlus className="size-4" />
        </button>
      )}
      {phase === 'select' && (
        <PrimaryButton onClick={onProcess} disabled={!ready || locked > 0}>
          {ready ? (
            <>
              Process {plural(ready, 'file')} <ArrowRight className="size-4" />
            </>
          ) : (
            'Nothing new'
          )}
        </PrimaryButton>
      )}
      {phase === 'processing' && (
        <>
          <span className="hidden items-center gap-2 text-sm text-zinc-400 sm:inline-flex">
            <span className="size-3.5 animate-spin rounded-full border-2 border-white/15 border-t-amber-200" /> Reading
          </span>
          <PrimaryButton onClick={onClose}>
            <span className="sm:hidden">Keep reading in background</span>
            <span className="hidden sm:inline">Continue in background</span>
          </PrimaryButton>
        </>
      )}
      {phase === 'done' && (retryable > 0 || ready > 0) && (
        <PrimaryButton onClick={onProcess} disabled={locked > 0}>
          {retryable ? (
            <>
              <RotateCw className="size-4" /> Retry {retryable}
              {ready ? ` + ${ready} new` : ''}
            </>
          ) : (
            <>
              Process {plural(ready, 'file')} <ArrowRight className="size-4" />
            </>
          )}
        </PrimaryButton>
      )}
      {phase === 'done' && retryable === 0 && ready === 0 && <PrimaryButton onClick={onDone}>Done</PrimaryButton>}
    </div>
  )
}

/** Files you've added before, recognised by content (not name), so a renamed copy is caught too. */
function KnownBanner({ count, total }: { count: number; total: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      className="overflow-hidden"
    >
      <p className="mx-3 mt-1 mb-2 flex items-start gap-2.5 rounded-xl bg-sky-300/[0.07] px-3 py-2.5 text-[13px] leading-snug text-sky-100 ring-1 ring-sky-300/20">
        <Copy className="mt-0.5 size-3.5 shrink-0 text-sky-300" />
        <span>
          {count === total ? (count === 1 ? 'You added this file before.' : `You added all ${count} of these before.`) : `${plural(count, 'file')} you added before.`}{' '}
          <span className="text-sky-200/70">Same content, even if renamed, so {count === 1 ? "it won't" : "they won't"} be read again.</span>
        </span>
      </p>
    </motion.div>
  )
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      className="inline-flex shrink-0 items-center gap-2 rounded-full bg-white px-5 py-2 text-sm font-semibold whitespace-nowrap text-zinc-950 shadow-lg shadow-black/40 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:bg-white/25 disabled:shadow-none"
    >
      {children}
    </motion.button>
  )
}
