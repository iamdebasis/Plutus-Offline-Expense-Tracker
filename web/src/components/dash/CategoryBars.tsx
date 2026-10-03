import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { inr } from '../../lib/money'
import type { PeriodView } from '../../lib/ledger'

interface Props {
  rows: PeriodView['byCategory']
  total: number
  selected: string | null
  onSelect: (id: string | null) => void
  /** Colour per top-level category, when the bars sit beside a chart that uses the same colours. One hue otherwise. */
  colourOf?: (id: string) => string
}

/** Ranked bars, one hue (the categories are the rows, not separate series). Selecting one narrows
 *  every chart and the table to it and opens its sub-categories. */
export function CategoryBars({ rows, total, selected, onSelect, colourOf }: Props) {
  const max = rows[0]?.amount ?? 0
  if (!rows.length) return <p className="py-8 text-center text-sm text-zinc-500">No spending in this period yet.</p>

  return (
    <ul className="space-y-1">
      {rows.map((row) => {
        const open = selected === row.id || row.children.some((c) => c.id === selected)
        const dim = selected !== null && !open
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(open && selected === row.id ? null : row.id)}
              aria-expanded={open}
              className={`group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-xl px-2 py-2 text-left transition sm:grid-cols-[minmax(0,10rem)_1fr_auto] ${
                open ? 'bg-white/[0.04]' : 'hover:bg-white/[0.025]'
              } ${dim ? 'opacity-45' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-zinc-200 sm:order-1">
                <ChevronRight className={`size-3.5 shrink-0 text-zinc-500 transition ${open ? 'rotate-90' : ''}`} />
                <span className="truncate" title={row.label}>
                  {row.label}
                </span>
              </span>
              <Bar value={row.amount} max={max} colour={colourOf?.(row.id)} />
              <span className="text-right text-sm whitespace-nowrap tabular-nums sm:order-3 sm:w-28">
                <span className="text-zinc-100">{inr(row.amount)}</span>
                <span className="ml-2 text-xs text-zinc-500">{share(row.amount, total)}</span>
              </span>
            </button>
            <AnimatePresence initial={false}>
              {open && row.children.length > 1 && (
                <motion.ul
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  {row.children.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(selected === c.id ? row.id : c.id)}
                        className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-lg px-2 py-1.5 pl-7 text-left transition hover:bg-white/[0.025] sm:grid-cols-[minmax(0,10rem)_1fr_auto] ${
                          selected === c.id ? 'text-zinc-100' : 'text-zinc-400'
                        }`}
                      >
                        <span className="truncate text-[13px] sm:order-1">{c.label}</span>
                        <Bar value={c.amount} max={max} thin colour={colourOf?.(row.id)} />
                        <span className="text-right text-[13px] tabular-nums sm:order-3 sm:w-28">{inr(c.amount)}</span>
                      </button>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </li>
        )
      })}
    </ul>
  )
}

function share(amount: number, total: number): string {
  const p = total > 0 ? (amount / total) * 100 : 0
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

function Bar({ value, max, thin, colour }: { value: number; max: number; thin?: boolean; colour?: string }) {
  // Phones: its own full-width line under the label. Wider screens: the middle column.
  return (
    <span className={`order-3 col-span-2 block sm:order-2 sm:col-span-1 ${thin ? 'h-1.5' : 'h-2.5'}`}>
      <motion.span
        className="block h-full rounded-r"
        style={{ background: colour ?? 'var(--color-series-1)' }}
        initial={{ width: 0 }}
        animate={{ width: `${Math.max(1.5, (value / max) * 100)}%` }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      />
    </span>
  )
}
