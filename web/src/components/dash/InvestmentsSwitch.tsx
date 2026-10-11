import { motion } from 'motion/react'

/** Whether investments count as spending. Sits with the years because, like them, it scopes everything below.
 *  Off: they're left out of every figure, chart and list (lib/scope.ts). On a phone it says just "Investments", so the
 *  years and the switch share one row; its name stays "Count investments". */
export function InvestmentsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Count investments"
      onClick={() => onChange(!on)}
      title={on ? 'Investments count as spending. Turn off to leave them out of everything.' : 'Investments are left out of everything. Turn on to count them as spending.'}
      className={`tap inline-flex shrink-0 items-center gap-2 rounded-xl py-2 pr-3 pl-2.5 text-[13px] font-semibold whitespace-nowrap ring-1 transition sm:gap-2.5 sm:pr-4 sm:pl-3 sm:text-sm ${
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
      <span className="sm:hidden">Investments</span>
      <span className="hidden sm:inline">Count investments</span>
    </button>
  )
}
