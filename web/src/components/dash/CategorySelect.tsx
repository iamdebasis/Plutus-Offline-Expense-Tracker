import { ChevronDown } from 'lucide-react'
import type { CategoryNode } from '../../types'

/** A native select grouped by top-level category: keyboard-friendly and fast with 60+ options. */
export function CategorySelect({
  tree,
  value,
  onChange,
  compact,
  label = 'Category',
}: {
  tree: CategoryNode[]
  value: string
  onChange: (id: string) => void
  compact?: boolean
  label?: string
}) {
  return (
    <label className="relative inline-flex min-w-0">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full min-w-0 cursor-pointer appearance-none truncate rounded-full bg-white/[0.05] pr-7 pl-3 text-zinc-200 ring-1 ring-white/10 transition outline-none hover:bg-white/[0.08] focus-visible:ring-white/40 ${
          compact ? 'py-1 text-xs' : 'py-1.5 text-sm'
        }`}
      >
        {tree.map((top) =>
          top.children?.length ? (
            <optgroup key={top.id} label={top.label} className="bg-zinc-900">
              <option value={top.id} className="bg-zinc-900">
                {top.label} (general)
              </option>
              {top.children.map((c) => (
                <option key={c.id} value={c.id} className="bg-zinc-900">
                  {c.label}
                </option>
              ))}
            </optgroup>
          ) : (
            <option key={top.id} value={top.id} className="bg-zinc-900">
              {top.label}
            </option>
          ),
        )}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-zinc-500" />
    </label>
  )
}
