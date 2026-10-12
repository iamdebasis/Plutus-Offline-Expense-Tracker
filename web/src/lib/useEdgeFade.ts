import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** How far a box's edge fades where there's more beyond it. */
export const FADE_PX = 24

/** A box that scrolls sideways when it needs more room than it has (the years on a narrow phone, the month-by-month
 *  table): it fades at an edge with more beyond it, so a cut-off row says it goes on. `key` changes when what's in it
 *  does; `settle` runs first on each change and resize (the years keep the chosen one in view); `start: false` fades
 *  the far edge only (the table, whose first column stays put). Returns the box's ref, the style that draws it, and
 *  whether there's more before and after (the table shades its pinned column's edge once scrolled). */
export function useEdgeFade<T extends HTMLElement>(key: unknown, { settle, start = true }: { settle?: (el: T) => void; start?: boolean } = {}) {
  const ref = useRef<T>(null)
  const [more, setMore] = useState({ before: false, after: false })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const edges = () => {
      const next = { before: el.scrollLeft > 1, after: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
      setMore((was) => (was.before === next.before && was.after === next.after ? was : next))
    }
    const again = () => {
      settle?.(el)
      edges()
    }
    again()
    el.addEventListener('scroll', edges, { passive: true })
    const watch = new ResizeObserver(again)
    watch.observe(el)
    return () => {
      el.removeEventListener('scroll', edges)
      watch.disconnect()
    }
  }, [key]) // `settle` reads the page, not the render: `key` alone says when to run again
  const before = start && more.before
  const mask =
    before || more.after
      ? `linear-gradient(to right, ${before ? 'transparent' : 'black'}, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${more.after ? 'transparent' : 'black'})`
      : undefined
  return [ref, { maskImage: mask, WebkitMaskImage: mask } satisfies CSSProperties, more] as const
}
