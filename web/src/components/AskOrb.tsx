import { useState, type Ref } from 'react'
import { PlutusLogo } from './brand/PlutusLogo'

/** The way into Ask Plutus: the gold mark in a dark glass orb, in the page's bottom-right corner whatever the scroll.
 *  At rest a faint gleam passes round its rim now and then; on hover or keyboard focus it opens into a pill that says
 *  "Ask Plutus" (the mark stays where it was) and the mark's drips run; they run too while a question is being read,
 *  panel open or not. Out of the way while the panel is open, and back, focused, when it closes. */
export function AskOrb({ open, busy, onOpen, ref }: { open: boolean; busy: boolean; onOpen: () => void; ref?: Ref<HTMLButtonElement> }) {
  const [near, setNear] = useState(false)
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      onPointerEnter={() => setNear(true)}
      onPointerLeave={() => setNear(false)}
      onFocus={() => setNear(true)}
      onBlur={() => setNear(false)}
      aria-label="Ask Plutus"
      aria-haspopup="dialog"
      aria-expanded={open}
      inert={open}
      className={`group fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex h-[52px] flex-row-reverse items-center rounded-full bg-panel/80 shadow-2xl ring-1 shadow-black/60 ring-white/[0.12] backdrop-blur-xl transition-[opacity,transform,box-shadow] duration-300 hover:ring-white/25 sm:right-6 sm:bottom-6 sm:h-14 ${
        open ? 'pointer-events-none scale-75 opacity-0' : 'scale-100 opacity-100'
      }`}
    >
      <span className="relative flex size-[52px] shrink-0 items-center justify-center sm:size-14">
        {/* the gleam: a short gold arc that sweeps the rim, then rests; gone while the pill is open */}
        <span aria-hidden className={`absolute inset-0 transition-opacity duration-300 ${near ? 'opacity-0' : ''}`}>
          <span className="ask-orb-gleam absolute inset-0 rounded-full" />
        </span>
        <PlutusLogo className="size-8 drop-shadow-[0_2px_8px_rgba(247,179,45,0.25)] sm:size-9" animated={near || busy} title="" />
      </span>
      <span
        className={`overflow-hidden text-sm font-semibold whitespace-nowrap text-zinc-100 transition-[max-width,opacity,padding] duration-300 ${
          near ? 'max-w-32 pl-5 opacity-100' : 'max-w-0 pl-0 opacity-0'
        }`}
      >
        {busy ? 'Reading…' : 'Ask Plutus'}
      </span>
    </button>
  )
}
