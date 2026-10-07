import { CloudAlert, HardDrive } from 'lucide-react'
import { api } from '../api'
import { plural, shortPath } from '../lib/format'
import { useStorage } from '../lib/storage'

/** Where your statements and screenshots are kept: always data/uploads, inside Plutus's own folder on this Mac,
 *  with everything else it knows about you. A click shows it in Finder. `className`: its spacing, from where it sits
 *  (by default the file sheet's sides). */
export function StoragePanel({ className = 'px-6 pb-2' }: { className?: string }) {
  const info = useStorage()
  if (!info) return null
  return (
    <div className={className}>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <HardDrive className="size-3.5 shrink-0" />
        <span className="shrink-0">Kept on this Mac in</span>
        <button
          type="button"
          onClick={() => api.revealStorage()}
          title={`${info.folder}\nShow in Finder`}
          className="min-w-0 truncate font-mono text-zinc-300 underline decoration-white/15 underline-offset-4 hover:decoration-white/60"
        >
          {shortPath(info.display, 44)}
        </button>
      </div>
      {info.cloudWarning && (
        <p className="mt-1.5 flex gap-1.5 pl-5.5 text-xs text-amber-300/90">
          <CloudAlert className="mt-px size-3.5 shrink-0" />
          {info.cloudWarning}
        </p>
      )}
    </div>
  )
}

/** The folder row in the vault: where the files are, and any that went missing. */
export function StorageLine() {
  const info = useStorage()
  if (!info) return null
  return (
    <div className="mt-3">
      <StoragePanel className="pb-2" />
      {info.missing > 0 && (
        <p className="pl-5.5 text-xs text-rose-300">
          {plural(info.missing, 'file')} missing from this folder. Were they moved or deleted in Finder?
        </p>
      )}
    </div>
  )
}
