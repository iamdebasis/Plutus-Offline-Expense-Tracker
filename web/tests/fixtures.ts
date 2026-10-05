// Fake ledgers in the shape the server hands them over: made-up payees, cards and amounts only.
import type { LedgerData } from '../src/lib/ledger'
import type { CardPayment, CardStatement, Instrument, Transaction } from '../src/types'

const categories = new Map(
  [
    ['shopping', 'Shopping'],
    ['food', 'Food'],
    ['investments', 'Investments'],
    ['transfers', 'Transfers'],
    ['income', 'Money in'],
    ['ignored', 'Ignored'],
    ['fees', 'Fees & charges'],
  ].map(([id, label]) => [id, { id, label, parent: null, excludeFromSpend: false }]),
)

let n = 0

/** A payment: by default a UPI payment from a bank account, in Shopping. */
export function txn(at: string, amount: number, over: Partial<Transaction> = {}): Transaction {
  n += 1
  return {
    id: `t${n}`,
    at: `${at}T12:00:00+05:30`,
    amount,
    direction: 'debit',
    kind: 'spend',
    channel: 'upi',
    app: 'phonepe',
    payee: `Fake Shop ${n}`,
    payeeHandle: null,
    paidFrom: 'XX1111',
    category: 'shopping.online',
    categorizedBy: 'rule',
    confidence: 1,
    needsReview: false,
    refs: {},
    sources: [{ upload: 'u_upi', page: null }],
    note: '',
    refundOf: null,
    settles: null,
    card: null,
    merchantCategory: null,
    ...over,
  }
}

export const card = (id: string, last4: string, network: string | null = null): Instrument => ({
  id,
  type: 'credit_card',
  issuer: 'Fake Bank',
  product: null,
  last4,
  network,
  name: 'Fake Bank',
  firstSeen: '2026-01-01T00:00:00Z',
  sources: [],
})

/** Paid with the card over UPI, as the server records it once it knows the card. */
export const onUpi = (cardId: string) => ({ channel: 'upi' as const, paidFrom: 'XXXX41', card: cardId })

/** A row of the card's statement: a purchase with its number. */
export const byNumber = (cardId: string, upload = 'u_stmt') => ({
  channel: 'card' as const,
  paidFrom: 'XXXX1141',
  card: cardId,
  refs: { cardRow: `row-${++n}` },
  sources: [{ upload, page: 1 }],
})

/** A bill from the CRED history, placed by the server: the cycle it paid, and its estimate (nothing when covered). */
export const bill = (id: string, cardId: string, at: string, amount: number, over: Partial<CardPayment>): CardPayment => ({
  id,
  at: `${at}T12:00:00+05:30`,
  amount,
  card: cardId,
  cardTitle: 'Fake Bank ••1141',
  refs: {},
  source: { upload: 'u_cred', page: null },
  verified: true,
  coveredBy: null,
  ...over,
})

export const statement = (id: string, cardId: string, from: string, to: string, kind: CardStatement['kind'] = 'statement'): CardStatement => ({
  id,
  kind,
  card: cardId,
  issuer: 'Fake Bank',
  last4: '1141',
  periodStart: from,
  periodEnd: to,
  statementDate: kind === 'statement' ? to : null,
  dueDate: null,
  previousBalance: null,
  totalDue: null,
  minimumDue: null,
  creditLimit: null,
  printedDebits: null,
  printedCredits: null,
  debits: 0,
  credits: 0,
  rows: 0,
  check: 'unchecked',
  difference: null,
  unread: [],
  status: 'proven',
  proof: '',
  held: [],
  edited: false,
  pages: [],
})

export function ledger(parts: Partial<LedgerData>): LedgerData {
  return {
    txns: [],
    payments: [],
    categories,
    tree: [],
    cards: [],
    uploads: [],
    accounts: [],
    preferences: { countInvestments: true },
    statements: [],
    held: [],
    leftOut: [],
    ...parts,
  }
}
