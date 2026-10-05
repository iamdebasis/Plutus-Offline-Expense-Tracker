import { useSyncExternalStore } from 'react'

/** Whether the Local AI panel is open. The AI pill in the header opens it, and so can the welcome page and the
 *  one-time hint, so it lives here rather than in one component. */
let open = false
const listeners = new Set<() => void>()

function set(value: boolean) {
  open = value
  for (const listener of listeners) listener()
}

export const aiPanel = {
  open: () => set(true),
  close: () => set(false),
}

export function useAiPanelOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => open,
  )
}
