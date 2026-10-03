import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { plural } from '../lib/format'
import { ACCEPT_ALL, SUPPORTED_EXTS, extOf, isTakeoutFile, type SourceMeta } from '../lib/sources'
import type { Activity } from '../lib/useImportActivity'
import { useSelection } from '../lib/useSelection'
import type { DeclaredKind } from '../types'
import { DropLayer } from './DropLayer'
import { FileSheet } from './FileSheet'
import { Toasts, useToasts } from './Toasts'

export interface Intake {
  browse: (source?: SourceMeta) => void
  /** Pick an export's extracted folder (Google Takeout) instead of its zip. */
  browseFolder: () => void
  notify: (text: string) => void
  /** Files of this page still on their way to the server. */
  pending: number
  element: ReactNode
}

/** Everything about adding files, for the whole app: the file picker, drop-anywhere, the review sheet
 *  and toasts. Reading happens in the background (see useImportActivity), so the sheet can be closed
 *  while it runs. `onChanged` fires once new files are stored. */
export function useFileIntake(activity: Activity, onChanged: () => void): Intake {
  const activityRef = useRef(activity)
  activityRef.current = activity
  const selection = useSelection({
    vault: () => activityRef.current.uploads,
    onUploaded: (rec) => activityRef.current.track([rec]),
  })
  const { toasts, push } = useToasts()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [knownCardIds, setKnownCardIds] = useState<Set<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const pickedKind = useRef<DeclaredKind | undefined>(undefined)

  // React has no prop for folder picking; the attribute switches the picker to folders (all current browsers).
  // Set as the input appears: the app renders nothing until its data has loaded.
  const attachFolderInput = useCallback((el: HTMLInputElement | null) => {
    folderInput.current = el
    el?.setAttribute('webkitdirectory', '')
  }, [])

  const { sync } = selection
  useEffect(() => {
    if (activity.uploads) sync(activity.uploads)
  }, [activity.uploads, sync])

  const addFiles = useCallback(
    (files: File[], kind?: DeclaredKind) => {
      const supported = files.filter((f) => SUPPORTED_EXTS.has(extOf(f.name)))
      const rejected = files.length - supported.length
      if (rejected) push(`${plural(rejected, 'file')} skipped: only PDF, images, ZIP, HTML or CSV`)
      if (!supported.length) return
      const repeats = selection.add(supported, kind)
      if (repeats) push(`${plural(repeats, 'file')} already in the list`)
      setSheetOpen(true)
    },
    [push, selection],
  )

  const browse = useCallback((source?: SourceMeta) => {
    pickedKind.current = source?.kind
    if (!input.current) return
    input.current.accept = source?.accept ?? ACCEPT_ALL
    input.current.value = ''
    input.current.click()
  }, [])

  const browseFolder = useCallback(() => {
    if (!folderInput.current) return
    folderInput.current.value = ''
    folderInput.current.click()
  }, [])

  /** Keep the Google Pay files of a Takeout folder; anything else in it (photos, other products) stays behind. */
  const addFolder = (files: File[]) => {
    if (!files.length) return
    const name = files[0].webkitRelativePath.split('/')[0] || 'Export'
    const keep = files.filter(isTakeoutFile)
    if (!keep.length) {
      push("This folder isn't a Google Pay export. Choose the folder you got by unzipping the Takeout download: it has a Google Pay folder inside")
      return
    }
    if (!selection.addFolder(name, keep)) push(`${name} is already in the list`)
    setSheetOpen(true)
  }

  const process = async () => {
    const cards = await api.instruments().catch(() => [])
    setKnownCardIds(new Set(cards.map((c) => c.id)))
    await selection.process()
    onChanged() // the vault list and any cards found on arrival
  }

  const finish = () => {
    setSheetOpen(false)
    setTimeout(selection.clear, 250) // let the sheet animate out first
  }

  const waiting = selection.phase === 'select' ? selection.items.filter((i) => i.status === 'ready').length : 0
  const pending = selection.items.filter((i) => selection.sending.includes(i.id) && (i.status === 'ready' || i.status === 'uploading')).length

  const element = (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => addFiles(Array.from(e.target.files ?? []), pickedKind.current)}
      />
      <input ref={attachFolderInput} type="file" multiple hidden onChange={(e) => addFolder(Array.from(e.target.files ?? []))} />
      <DropLayer onFiles={(files) => addFiles(files)} />
      <FileSheet
        open={sheetOpen}
        items={selection.items}
        phase={selection.phase}
        knownCardIds={knownCardIds}
        onClose={() => setSheetOpen(false)}
        onClear={() => {
          selection.clear()
          setSheetOpen(false)
        }}
        onAddMore={() => browse()}
        onAddFolder={browseFolder}
        onProcess={process}
        onDone={finish}
        onRemove={(id) => {
          selection.remove(id)
          if (selection.items.length === 1) setSheetOpen(false)
        }}
        onKind={(id, kind) => selection.patch(id, { kind })}
        onPassword={(id, password) => selection.patch(id, { password })}
        notify={push}
      />
      <AnimatePresence>
        {!sheetOpen && waiting > 0 && (
          <motion.button
            type="button"
            onClick={() => setSheetOpen(true)}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 z-30 inline-flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-zinc-900/90 py-2 pr-2 pl-5 text-sm text-zinc-200 shadow-2xl shadow-black/50 backdrop-blur"
          >
            {plural(waiting, 'file')} ready to process
            <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 font-semibold text-zinc-950">
              Review <ArrowRight className="size-3.5" />
            </span>
          </motion.button>
        )}
      </AnimatePresence>
      <Toasts toasts={toasts} />
    </>
  )

  return { browse, browseFolder, notify: push, pending, element }
}
