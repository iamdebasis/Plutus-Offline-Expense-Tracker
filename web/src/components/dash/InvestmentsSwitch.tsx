import { motion } from 'motion/react'

/** Whether investments count as spending. Sits with the years because, like them, it scopes everything below.
 *  Off: they're left out of every figure, chart and list (lib/scope.ts). */
export function InvestmentsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={on ? 'Investments count as spending. Turn off to leave them out of everything.' : 'Investments are left out of everything. Turn on to count them as spending.'}
      className={`inline-flex shrink-0 items-center gap-2.5 rounded-xl py-2 pr-4 pl-3 text-sm font-semibold whitespace-nowrap ring-1 transition ${
        on ? 'text-zinc-100 ring-white/30' : 'text-zinc-400 ring-white/10 hover:text-zinc-100 hover:ring-white/25'
      }`}
    >
      <span aria-hidden className={`relative h-[18px] w-8 rounded-full transition-colors duration-200 ${on ? 'bg-white' : 'bg-white/[0.12]'}`}>
        <motion.span
          initial={false}
          animate={{ x: on ? 14 : 0 }}
          transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          className={`absolute top-[3px] left-[3px] size-3 rounded-full transition-colors duration-200 ${on ? 'bg-zinc-950' : 'bg-zinc-400'}`}
        />
      </span>
      Count investments
    </button>
  )
}
