import type { ReactNode } from 'react'

/** A dashboard section's title row: icon, title, and a note on the right. */
export function SectionHead({ icon, title, note }: { icon: ReactNode; title: string; note: string }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
      <h2 className="flex items-center gap-2.5 font-display text-2xl font-semibold tracking-tight">
        <span className="flex size-8 items-center justify-center rounded-xl bg-white/[0.07] text-zinc-200 ring-1 ring-white/10">{icon}</span>
        {title}
      </h2>
      <p className="text-sm text-zinc-500">{note}</p>
    </header>
  )
}

/** A card inside a section. */
export function Panel({
  id,
  title,
  note,
  badge,
  actions,
  flush,
  className = '',
  children,
}: {
  id?: string
  title: string
  note?: string
  badge?: number
  /** Buttons at the right of the title row. */
  actions?: ReactNode
  /** The body spaces itself from the title (for a body that collapses away). */
  flush?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <section id={id} className={`min-w-0 rounded-3xl border border-white/[0.07] bg-[#0c0e13]/90 p-4 sm:p-5 ${className}`}>
      <header className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-3 ${children && !flush ? 'mb-4' : ''}`}>
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="flex items-center gap-2 font-display text-[17px] font-semibold tracking-tight">
            {title}
            {badge !== undefined && (
              <span className="rounded-full bg-[var(--color-status-warning)]/15 px-2 py-px text-xs font-semibold text-[var(--color-status-warning)]">{badge}</span>
            )}
          </h3>
          {note && <p className="mt-0.5 text-sm text-zinc-500">{note}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
