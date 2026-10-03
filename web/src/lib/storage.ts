import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { StorageInfo } from '../types'

/** Where your files are kept, shared by every component that shows it (the file sheet, the vault). */

let current: StorageInfo | null = null
const listeners = new Set<() => void>()

const set = (info: StorageInfo) => {
  current = info
  listeners.forEach((l) => l())
}

export const reloadStorage = () => api.storage().then(set)

export function useStorage(): StorageInfo | null {
  const info = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
  useEffect(() => {
    reloadStorage().catch(() => {})
  }, [])
  return info
}
