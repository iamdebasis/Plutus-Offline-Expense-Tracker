export type DeclaredKind = 'auto' | 'cc_statement' | 'cred_history' | 'upi_statement' | 'screenshot'
export type FileKind =
  | 'cc_statement'
  | 'cred_history'
  | 'upi_statement'
  | 'gpay_takeout'
  | 'screenshot'
  | 'bank_statement'
  | 'unknown'

export interface CardRef {
  issuer: string | null
  product: string | null
  last4: string
  network: string | null
}

export interface Detection {
  kind: FileKind
  label: string
  source: string | null
  confidence: number
  pages: number | null
  textLayer: boolean | null
  encrypted: boolean
  period: { start: string; end: string } | null
  cards: CardRef[]
  paymentSources: { mask: string; count: number }[]
  notes: string[]
}

export interface UploadRecord {
  id: string
  originalName: string
  storedPath: string
  sha256: string
  size: number
  mediaType: string | null
  declaredKind: DeclaredKind
  detection: Detection
  uploadedAt: string
  unlocked: boolean
  importStatus: ImportStatus | null
  duplicate?: boolean
}

/** Where uploaded originals are kept: always data/uploads (app/storage.py). */
export interface StorageInfo {
  folder: string
  display: string
  /** Plutus's folder syncs to a cloud drive, so your data would leave this Mac. */
  cloudWarning: string | null
  files: number
  bytes: number
  missing: number
}

export interface Instrument extends CardRef {
  id: string
  type: 'credit_card'
  name: string
  firstSeen: string
  sources: string[]
}

/** The model's state, not the server's: asleep whenever it isn't loaded, whoever runs Ollama. */
export type LlmState = 'unavailable' | 'asleep' | 'starting' | 'working' | 'awake' | 'stopping'

export interface LlmStatus {
  state: LlmState
  model: string
  installed: boolean
  modelInstalled: boolean | null
  /** In memory right now. */
  loaded: boolean
  /** Who runs the Ollama server: this app (stops it when idle), Ollama's own app or server (left running), or nobody. */
  server: 'plutus' | 'ollama' | null
  /** Seconds until it's unloaded, while awake and idle. */
  sleepsIn: number | null
  idleSeconds: number
}

/** One of your own bank accounts (data/accounts.json): transfers to and from it are left out. */
export interface OwnAccount {
  last4: string
  label: string
  /** The name it was marked from, account number cut to its last four digits. */
  seenAs: string
  addedAt: string
}

/** Your choices about what the numbers include (data/settings.json). */
export interface Preferences {
  countInvestments: boolean
}

export interface ImportStatus {
  state: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  step: string | null
  method: string | null
  found: number
  added: number
  duplicates: number
  /** payees to review */
  needsReview: number
  error: string | null
  finishedAt: string | null
  /** For an export with many parts (Google Pay Takeout): what each held and what became of it. */
  details?: string[]
}

export type TxnKind = 'spend' | 'refund' | 'cashback' | 'income' | 'transfer' | 'bill_payment'

export interface Transaction {
  id: string
  at: string
  amount: number
  direction: 'debit' | 'credit'
  kind: TxnKind
  channel: 'upi' | 'card' | 'other'
  app: string | null
  payee: string
  payeeHandle: string | null
  paidFrom: string | null
  category: string
  categorizedBy: string
  confidence: number
  needsReview: boolean
  refs: Record<string, string>
  sources: { upload: string; page: number | null }[]
  note: string
  /** For a refund: the payment it gives money back for. */
  refundOf?: string | null
  /** For a UPI payment to CRED: the card bill (in your CRED history) it paid. */
  settles?: string | null
  /** For a row of a card statement (or a card used on UPI): the card it was charged to. */
  card?: string | null
  /** The bank's own category for a card purchase ("Restaurants"). */
  merchantCategory?: string | null
}

/** A credit card statement you added: what it covers, the bank's figures, and whether its rows add up to them. */
export interface CardStatement {
  id: string
  /** 'statement': the bank's monthly statement (one billing cycle, with its totals). 'export': the card's
   *  transactions over a span, from the bank's app or site (no cycle, usually no totals). */
  kind: 'statement' | 'export'
  card: string | null
  issuer: string | null
  last4: string | null
  periodStart: string | null
  periodEnd: string | null
  statementDate: string | null
  dueDate: string | null
  previousBalance: number | null
  totalDue: number | null
  minimumDue: number | null
  creditLimit: number | null
  debits: number
  credits: number
  rows: number
  check: 'matched' | 'mismatch' | 'unchecked'
  difference: number | null
  /** Lines inside the transactions table that weren't read as rows though they carry an amount: where a missing
   *  row is, when the rows don't add up. */
  unread: string[]
}

export interface CardPayment {
  id: string
  at: string
  amount: number
  card: string
  cardTitle: string
  refs: Record<string, string>
  source: { upload: string; page: number | null }
  verified: boolean
  /** The card statement this bill pays, when you added it: its purchases are counted one by one instead. */
  coveredBy?: string | null
  /** The billing cycle it pays for: its statement's period, the card's cycle as its statements show it, or a guess
   *  for a card with none (backend/app/billing.py). */
  paysFrom?: string | null
  paysTo?: string | null
  cycle?: 'statement' | 'card' | 'guess' | null
  /** Paid with the card on UPI in that cycle: counted under UPI already, so it comes off the bill. */
  counted?: number
  /** The card purchases it's taken to pay for: nothing when it pays a statement you added. */
  estimate?: number
}

export interface CategoryNode {
  id: string
  label: string
  excludeFromSpend?: boolean
  children?: CategoryNode[]
}
