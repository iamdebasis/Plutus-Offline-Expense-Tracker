import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** A page of a file you added, drawn here on this Mac (pdf.js), with the row in question marked: to check a row of a
 *  statement on hold against what the bank printed. `y` is where the row sits, in points from the top of the page. */
export function PagePeek({ url, name, page, y, onClose }: { url: string; name: string; page: number; y: number | null; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [mark, setMark] = useState<{ top: number; height: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    const draw = async () => {
      const pdfjs = await import('pdfjs-dist')
      const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer())
      const task = pdfjs.getDocument({ data })
      try {
        const doc = await task.promise
        const p = await doc.getPage(Math.min(Math.max(1, page), doc.numPages))
        const base = p.getViewport({ scale: 1 })
        const shown = Math.min(760, window.innerWidth - 48) / base.width // CSS pixels per point
        const dpr = window.devicePixelRatio || 1
        const viewport = p.getViewport({ scale: shown * dpr })
        const c = canvas.current
        if (!c || cancelled) return
        c.width = Math.ceil(viewport.width)
        c.height = Math.ceil(viewport.height)
        c.style.width = `${viewport.width / dpr}px`
        c.style.height = `${viewport.height / dpr}px`
        await p.render({ canvas: c, viewport }).promise
        if (y !== null && !cancelled) {
          setMark({ top: (y - 8) * shown, height: 16 * shown })
          frame.current?.scrollTo({ top: Math.max(0, y * shown - 160) })
        }
      } finally {
        await task.destroy()
      }
    }
    draw().catch(() => !cancelled && setError("This file couldn't be shown here."))
    return () => {
      cancelled = true
    }
  }, [url, page, y])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${name}, page ${page}`}>
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full flex-col overflow-hidden rounded-2xl bg-zinc-900 ring-1 ring-white/10"
      >
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
          <p className="min-w-0 flex-1 truncate text-sm text-zinc-300">
            {name} · page {page}
            {y !== null && <span className="text-zinc-500"> · the row is marked</span>}
          </p>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100">
            <X className="size-4" />
          </button>
        </div>
        <div ref={frame} className="relative overflow-auto bg-white">
          {error ? (
            <p className="px-6 py-10 text-sm text-zinc-600">{error}</p>
          ) : (
            <>
              <canvas ref={canvas} className="block" />
              {mark && (
                <span aria-hidden className="pointer-events-none absolute inset-x-0 bg-amber-300/30 ring-2 ring-amber-400/80" style={{ top: mark.top, height: mark.height }} />
              )}
            </>
          )}
        </div>
      </motion.div>
    </div>
  )
}
