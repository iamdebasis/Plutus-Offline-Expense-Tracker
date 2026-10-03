import type { Transaction } from '../types'
import { isLinkedRefund, topOf, type LedgerData } from './ledger'

/** Investments can be left out of the dashboard, for people who track them somewhere else. Left out means gone:
 *  from every total, chart and list, as if they were never paid. A refund goes where its payment went, so a
 *  returned SIP leaves with the SIP instead of lowering your spending.
 *
 *  The left-out payments are kept to one side (`leftOut`) for two jobs only: the "₹X left out" note, and card
 *  bills. A card's bills pay for everything bought with it, investments on UPI included, so those still come off
 *  the bill; otherwise they'd come back in as card purchases. */
export const INVESTMENTS = 'investments'

export function scoped(data: LedgerData, countInvestments: boolean): LedgerData {
  if (countInvestments) return data
  const byId = new Map(data.txns.map((t) => [t.id, t]))
  const txns: Transaction[] = []
  const leftOut: Transaction[] = []
  for (const t of data.txns) (isInvestment(t, byId) ? leftOut : txns).push(t)
  return leftOut.length ? { ...data, txns, leftOut } : data
}

export function isInvestment(t: Transaction, byId: Map<string, Transaction>): boolean {
  const owner = (isLinkedRefund(t) && byId.get(t.refundOf!)) || t
  return topOf(owner.category) === INVESTMENTS
}
