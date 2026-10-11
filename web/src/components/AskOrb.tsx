import { useEffect, useRef, useState, type RefObject } from 'react'
import { PlutusLogo } from './brand/PlutusLogo'

/** The way into Ask Plutus: the gold mark in a dark glass orb, in the page's bottom-right corner whatever the scroll.
 *  At rest a faint gleam passes round its rim now and then; on hover or keyboard focus it opens into a pill that says
 *  "Ask Plutus" (the mark stays where it was) and the mark's drips run; they run too while a question is being read,
 *  panel open or not. Out of the way while the panel is open, and back, focused, when it closes. Where it would cover
 *  the page's column (a phone, a narrow window), it shrinks into the corner while you scroll down, and is back as
 *  soon as you scroll up or stop. */
export function AskOrb({ open, busy, onOpen, ref }: { open: boolean; busy: boolean; onOpen: () => void; ref?: RefObject<HTMLButtonElement | null> }) {
  const [near, setNear] = useState(false)
  const own = useRef<HTMLButtonElement>(null)
  const self = ref ?? own
  const aside = useStepAside(self, near || open)
  return (
    <button
      ref={self}
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
      className={`group fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex h-[52px] origin-bottom-right flex-row-reverse items-center rounded-full bg-panel/80 shadow-2xl ring-1 shadow-black/60 ring-white/[0.12] backdrop-blur-xl transition-[opacity,scale,translate,box-shadow] duration-300 hover:ring-white/25 motion-reduce:transition-none sm:right-6 sm:bottom-6 sm:h-14 ${
        open ? 'pointer-events-none scale-75 opacity-0' : aside ? 'translate-x-2.5 scale-[0.4] opacity-80' : 'scale-100 opacity-100'
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

/** How long after the last scroll the orb comes back. */
const BACK_AFTER_MS = 900
/** Scrolling less than this (a finger's tremor, a trackpad's settle) changes nothing. */
const JITTER_PX = 6

/** True while you scroll down and the orb would cover the page's column (its left edge inside the main column's
 *  content), so what you're scrolling past isn't under it; false as soon as you scroll up, BACK_AFTER_MS after you
 *  stop, and always while `still` (it's open, hovered or focused). Measured on each scroll, so it follows the window. */
function useStepAside(orb: RefObject<HTMLElement | null>, still: boolean) {
  const [aside, setAside] = useState(false)
  useEffect(() => {
    setAside(false)
    if (still) return
    let last = window.scrollY
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const covers = () => {
      const el = orb.current
      const main = document.querySelector('main')
      if (!el || !main) return false
      // where it sits at rest, whatever it's doing now: the right offset and width ignore its shrinking
      const left = window.innerWidth - parseFloat(getComputedStyle(el).right) - el.offsetWidth
      return left < main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight)
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const dy = window.scrollY - last
        if (Math.abs(dy) < JITTER_PX) return
        last = window.scrollY
        clearTimeout(timer)
        if (dy > 0 && covers()) {
          setAside(true)
          timer = setTimeout(() => setAside(false), BACK_AFTER_MS)
        } else setAside(false)
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [orb, still])
  return aside
}
