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
  /** The model Plutus uses: your choice in the Local AI panel, or the best one downloaded for this Mac; null when
   *  none is set up ("unavailable"). */
  model: string | null
  installed: boolean
  modelInstalled: boolean | null
  /** In memory right now. */
  loaded: boolean
  /** Who runs the Ollama server: this app (stops it when idle), Ollama's own app or server (left running), or nobody. */
  server: 'plutus' | 'ollama' | null
  /** Seconds until it's unloaded, while awake and idle. */
  sleepsIn: number | null
  idleSeconds: number
  /** You've answered the one-time hint about the local AI. */
  hintSeen: boolean
}

/** A model Ollama has downloaded, and how it fits this Mac. */
export interface AiModel {
  name: string
  sizeGb: number
  fit: 'suits' | 'heavy' | 'too_big'
  /** One Plutus suggests or knows works well; others are "not tested with Plutus". */
  known: boolean
  /** Reads images (payment screenshots); null when Plutus can't tell. */
  vision: boolean | null
  /** Answers questions (an embedding model doesn't). */
  usable: boolean
  note: string
  inUse: boolean
}

/** One thing to do, for you: Plutus never downloads or installs anything itself. */
export interface AiStep {
  text: string
  /** For Terminal, with a copy button. */
  command: string | null
  link: string | null
  optional: boolean
}

/** The Local AI panel (/api/llm/setup): this Mac, Ollama, what's downloaded, and the steps to what suits it. */
export interface AiSetup {
  headline: string
  ready: boolean
  inUse: string | null
  chosen: string | null
  /** Set by ET_OLLAMA_MODEL: wins over any choice here. */
  override: string | null
  mac: { chip: string; appleSilicon: boolean; memoryGb: number; freeGb: number; macos: string }
  ollama: {
    installed: boolean
    app: boolean
    homebrew: 'cask' | 'formula' | null
    version: string | null
    minVersion: string
    running: boolean
    versionOk: boolean | null
  }
  suggestion: { model: string; sizeGb: number; why: string; downloaded: boolean } | null
  models: AiModel[]
  notes: string[]
  steps: AiStep[]
  hintSeen: boolean
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
  /** rows of a statement on hold: read, not counted until you confirm them */
  held?: number
  error: string | null
  finishedAt: string | null
  /** For an export with many parts (Google Pay Takeout): what each held and what became of it. */
  details?: string[]
}

export type TxnKind = 'spend' | 'refund' | 'cashback' | 'income' | 'transfer' | 'bill_payment'

/** How a payment was sorted, to put it back after a change of several (undo). */
export interface PaymentState {
  id: string
  category: string
  categorizedBy: Transaction['categorizedBy']
  confidence: number
  needsReview: boolean
}

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
  /** The files it was read from; a statement's row also says where on its page (y, in points from the top). */
  sources: { upload: string; page: number | null; y?: number | null }[]
  note: string
  /** For a refund: the payment it gives money back for. */
  refundOf?: string | null
  /** For a side of a card bill payment (the UPI payment that paid it, the statement's "PAYMENT RECEIVED"): the bill it
   *  is. Every side of one payment points to the same bill, so it's shown once (lib/ledger.ts, `oneRowPerPayment`). */
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
  /** Its own totals of debits and of credits, as printed: what a year's summary (no balances) is checked against. */
  printedDebits: number | null
  printedCredits: number | null
  debits: number
  credits: number
  rows: number
  check: 'matched' | 'mismatch' | 'unchecked'
  difference: number | null
  /** Lines inside the transactions table that weren't read as rows though they carry an amount: where a missing
   *  row is, when the rows don't add up. */
  unread: string[]
  /** proven: its own arithmetic accounts for every row. exact: read from a file's own cells. agreed: the rules and
   *  the local AI read the same rows. confirmed: you checked it. on_hold: none of those, so its rows aren't counted
   *  until you confirm them. null: read before statements had a status. */
  status: 'proven' | 'exact' | 'agreed' | 'confirmed' | 'on_hold' | null
  /** How it was proven, or why it couldn't be, in words. */
  proof: string
  /** A statement on hold's rows, waiting for you. */
  held: Transaction[]
  /** You corrected its held rows. */
  edited: boolean
  /** The file's pages it was read from, when the file holds several statements (a year's download); empty: all. */
  pages: number[]
}

/** A row of a statement on hold, as you corrected it. */
export interface HeldRow {
  at: string
  amount: number
  direction: 'debit' | 'credit'
  description: string
  page: number
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
  /** Where it was read: a payment app's history (CRED and similar), or a card statement's own row for it, when no app
   *  recorded that payment (backend/app/billing.py, `statement_bills`). Placed the same way either way. */
  origin?: 'app' | 'statement'
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

/** What Start over would move to the Trash (/api/reset), counted, and why it can't happen right now, if so. */
export interface ResetPreview {
  anything: boolean
  transactions: number
  files: number
  cards: number
  statements: number
  /** Categories you set for one payment, and your corrections for a payee. */
  answers: number
  payees: number
  accounts: number
  cardPictures: number
  /** The data folder, where it can all be put back. */
  folder: string
  busy: string | null
}

/** The local AI's reading of a question (POST /api/ask): a query the page answers, with periods as days only (the page
 *  names them). See lib/ask.ts `AskQuery`. */
export interface AiQuery {
  kind: 'total' | 'count' | 'average' | 'top' | 'largest' | 'compare' | 'trend' | 'list' | 'last'
  categories: string[]
  payees: string[]
  cards: string[]
  channel: 'all' | 'upi' | 'cards'
  money: 'out' | 'in'
  period: { from: string; to: string } | null
  compareTo: { from: string; to: string } | null
  by: 'payee' | 'category'
  per: 'payment' | 'month'
  limit: number
}
