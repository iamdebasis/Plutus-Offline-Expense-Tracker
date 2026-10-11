import { useLayoutEffect, useRef, useState } from 'react'

/** Whether a box is at least `min` pixels wide, followed as it resizes: for content with a wide form (a table) and a
 *  narrow one (a list), so nothing has to scroll sideways on a phone. It goes by the box, not the screen, so a narrow
 *  column on a wide screen gets the narrow form too; measured before the first paint, so the wrong one never shows. */
export function useFits<T extends HTMLElement>(min: number) {
  const ref = useRef<T>(null)
  const [fits, setFits] = useState(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setFits(el.clientWidth >= min)
    measure()
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [min])
  return [ref, fits] as const
}
