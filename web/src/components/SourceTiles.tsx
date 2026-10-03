import { motion } from 'motion/react'
import { Plus } from 'lucide-react'
import type { MouseEvent } from 'react'
import { SOURCES, type SourceMeta } from '../lib/sources'

export function SourceTiles({ onPick }: { onPick: (source: SourceMeta) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {SOURCES.map((source, i) => (
        <motion.button
          key={source.kind}
          type="button"
          onClick={() => onPick(source)}
          onMouseMove={spotlight}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 + i * 0.06, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.985 }}
          className="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5 text-left transition-colors duration-300 hover:border-white/[0.14] hover:bg-white/[0.035]"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            style={{ background: `radial-gradient(260px circle at var(--x, 50%) var(--y, 0%), ${source.glow}, transparent 65%)` }}
          />
          <span className={`relative flex size-10 items-center justify-center rounded-xl ring-1 ${source.iconClass}`}>
            <source.icon className="size-[18px]" strokeWidth={1.8} />
          </span>
          <span className="relative mt-5 block font-medium text-zinc-100">{source.title}</span>
          <span className="relative mt-1 block text-sm leading-snug text-zinc-400">{source.hint}</span>
          <span className="relative mt-5 flex items-center justify-between">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-zinc-500">{source.formats}</span>
            <span className="flex size-7 -translate-x-1 items-center justify-center rounded-full bg-white/[0.06] text-zinc-300 opacity-0 transition duration-300 group-hover:translate-x-0 group-hover:opacity-100">
              <Plus className="size-4" />
            </span>
          </span>
        </motion.button>
      ))}
    </div>
  )
}

function spotlight(e: MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--x', `${e.clientX - rect.left}px`)
  e.currentTarget.style.setProperty('--y', `${e.clientY - rect.top}px`)
}
