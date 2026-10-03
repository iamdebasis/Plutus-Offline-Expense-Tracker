import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, FileArchive, FolderOpen } from 'lucide-react'
import { useState } from 'react'

/** How to get your Google Pay history: the app has no download for all of it, Google Takeout does. Add the zip
 *  Google sends, or the folder you get by unzipping it. */
export function GooglePayGuide({ onZip, onFolder }: { onZip: () => void; onFolder: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.015]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-3.5 text-left">
        <span className="text-sm text-zinc-300">Using Google Pay?</span>
        <span className="text-sm text-zinc-500">Your whole history comes from Google Takeout.</span>
        <ChevronDown className={`ml-auto size-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="grid gap-5 border-t border-white/[0.06] px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <ol className="space-y-1.5 text-sm text-zinc-400">
                <li>
                  <span className="mr-2 text-zinc-600 tabular-nums">1</span>On your computer, open <span className="font-mono text-zinc-200">takeout.google.com</span>, signed in with
                  the Google account you use for Google Pay, and choose <span className="text-zinc-200">Deselect all</span>.
                </li>
                <li>
                  <span className="mr-2 text-zinc-600 tabular-nums">2</span>Tick <span className="text-zinc-200">Google Pay</span>, then{' '}
                  <span className="text-zinc-200">Next step → Create export</span>. Google emails you a zip, usually within minutes.
                </li>
                <li>
                  <span className="mr-2 text-zinc-600 tabular-nums">3</span>Add the zip as it is, or unzip it and choose the folder. Plutus reads only
                  the Google Pay part, on this Mac.
                </li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onZip}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200"
                >
                  <FileArchive className="size-4" /> Add the zip
                </button>
                <button
                  type="button"
                  onClick={onFolder}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
                >
                  <FolderOpen className="size-4" /> Choose the folder
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
