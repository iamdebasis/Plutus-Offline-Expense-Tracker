/** Start over, in the browser: the server moves everything it keeps about you to the Trash (backend/app/reset.py) and
 *  never lets the browser cache an answer about you (app/main.py); the page forgets what it kept here itself, the
 *  moment the server confirms, and tells every other open tab of Plutus to load again, empty. Nothing of yours stays
 *  in this browser. */

/** What the page keeps in the browser starts with this: how its panels were left (collapsed sections, ticked chart
 *  lines, among them your cards' ids). Nothing else is ever kept there. */
const PREFIX = 'plutus.'
const CHANNEL = 'plutus'
const STARTED_OVER = 'started over'
/** This tab, so it can tell its own news from another tab's. */
const TAB = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

type Kept = { readonly length: number; key(index: number): string | null; removeItem(key: string): void }

const browserStorage = (): Kept | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // a browser that keeps nothing for the page
  }
}

/** Removes everything the page kept in this browser (and nothing another page kept); how many it removed. */
export function forgetThisBrowser(kept: Kept | null = browserStorage()): number {
  if (!kept) return 0
  try {
    const ours: string[] = []
    for (let i = 0; i < kept.length; i++) {
      const key = kept.key(i)
      if (key?.startsWith(PREFIX)) ours.push(key)
    }
    for (const key of ours) kept.removeItem(key)
    return ours.length
  } catch {
    return 0
  }
}

/** Tells every other open tab of Plutus that you started over. */
export function tellOtherTabs(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL)
  channel.postMessage({ kind: STARTED_OVER, from: TAB })
  channel.close()
}

/** Calls `then` when another tab of Plutus starts over (never for this tab's own); returns how to stop listening. */
export function whenStartedOverElsewhere(then: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e: MessageEvent) => {
    const news = e.data as { kind?: unknown; from?: unknown } | null
    if (news?.kind === STARTED_OVER && news.from !== TAB) then()
  }
  return () => channel.close()
}
