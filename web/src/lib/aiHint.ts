import type { LlmStatus } from '../types'
import { plural } from './format'

/** What a finished run of imports left waiting that a local AI could have handled: payees no rule knows, and
 *  statements the rules couldn't prove (summarize() in useImportActivity). */
export interface Waiting {
  reading: boolean
  toReview: number
  onHold: number
}

/** The one-time hint about the local AI: once a run of imports has finished with something waiting, while there's no
 *  local AI to handle it (not set up, or its model isn't downloaded), until you answer it. Never while reading. */
export function shouldHint(run: Waiting | null, status: LlmStatus | null): boolean {
  if (!run || !status || status.hintSeen || run.reading) return false
  const notSetUp = status.state === 'unavailable' || status.modelInstalled === false
  return notSetUp && (run.toReview > 0 || run.onHold > 0)
}

export function hintText(run: Waiting): string {
  const parts: string[] = []
  if (run.toReview) parts.push(`${plural(run.toReview, 'payee')} ${run.toReview === 1 ? 'needs' : 'need'} your eyes`)
  if (run.onHold) parts.push(`${plural(run.onHold, 'statement')} ${run.onHold === 1 ? 'is' : 'are'} on hold`)
  const them = run.toReview + run.onHold === 1 ? 'it' : 'them'
  return `${parts.join(' and ')}. A local AI on this Mac could handle ${them} for you.`
}
