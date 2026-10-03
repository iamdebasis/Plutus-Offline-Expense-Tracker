import { AnimatePresence, motion } from 'motion/react'
import { ArrowDownToLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/** Lets files be dropped anywhere on the page, with a full-screen target while dragging. */
export function DropLayer({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) onFilesRef.current(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <AnimatePresence>
      {dragging && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-canvas/75 p-6 backdrop-blur-md"
        >
          <motion.div
            initial={{ scale: 0.94 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="flex h-full max-h-[520px] w-full max-w-3xl flex-col items-center justify-center rounded-[32px] border-2 border-dashed border-white/40 bg-white/[0.03]"
          >
            <motion.span
              animate={{ y: [0, 6, 0] }}
              transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
              className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-white ring-1 ring-white/25"
            >
              <ArrowDownToLine className="size-7" />
            </motion.span>
            <p className="mt-6 font-display text-2xl font-semibold tracking-tight">Drop to add</p>
            <p className="mt-2 text-sm text-zinc-400">Statements, UPI history and screenshots. We sort them out.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
