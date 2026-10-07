import type { AskQuery } from './lib/ask'
import type { AiQuery, AiSetup, CardPayment, CardStatement, CategoryNode, DeclaredKind, HeldRow, Instrument, LlmStatus, OwnAccount, PaymentState, Preferences, ResetPreview, StorageInfo, Transaction, UploadRecord } from './types'

export class ApiError extends Error {
  readonly code: string | undefined
  readonly status: number

  constructor(message: string, code: string | undefined, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(body?.detail?.message ?? `Request failed (${res.status})`, body?.detail?.code, res.status)
  return body as T
}

export const api = {
  uploads: () => request<UploadRecord[]>('/api/uploads'),
  reimport: (id: string) => request<UploadRecord>(`/api/uploads/${id}/reimport`, { method: 'POST' }),
  instruments: () => request<Instrument[]>('/api/instruments'),
  cardArt: () => request<string[]>('/api/card-art'),
  /** The file as you added it, for showing a page of it on this Mac. */
  uploadFile: (id: string) => `/api/uploads/${encodeURIComponent(id)}/file`,
  correctHeld: (id: string, rows: HeldRow[]) =>
    request<CardStatement>(`/api/card-statements/${encodeURIComponent(id)}/held`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rows),
    }),
  confirmHeld: (id: string) => request<CardStatement>(`/api/card-statements/${encodeURIComponent(id)}/confirm`, { method: 'POST' }),
  llmStatus: () => request<LlmStatus>('/api/llm/status'),
  /** What Start over would move to the Trash, and whether it can happen now. */
  resetPreview: () => request<ResetPreview>('/api/reset'),
  /** Everything Plutus keeps about you, to the Trash (recoverable until it's emptied). `confirm`: the words typed. */
  startOver: (confirm: string) =>
    request<{ moved: number; trash: string | null }>('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm }),
    }),
  /** The Local AI panel: this Mac, Ollama, what's downloaded, and the steps to what suits it. */
  aiSetup: () => request<AiSetup>('/api/llm/setup'),
  /** Use this downloaded model from now on; null lets Plutus pick the best one for this Mac again. */
  chooseModel: (model: string | null) =>
    request<AiSetup>('/api/llm/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  /** A question the page's rules couldn't read, read by the local AI into a query (the page answers it from the
   *  ledger). The model gets the question, the categories and today's date; never a transaction. 409: no local AI. */
  ask: (question: string, previous: AskQuery | null) =>
    request<{ understood: boolean; query: AiQuery | null }>('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, previous }),
    }),
  /** The one-time hint about the local AI was answered: it doesn't show again. */
  aiHintSeen: () => request<void>('/api/llm/hint-seen', { method: 'POST' }),
  deleteUpload: (id: string) => request<void>(`/api/uploads/${id}`, { method: 'DELETE' }),
  setCardNetwork: (id: string, network: string | null) =>
    request<Instrument>(`/api/instruments/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network }),
    }),
  storage: () => request<StorageInfo>('/api/storage'),
  revealStorage: () => request<void>('/api/storage/reveal', { method: 'POST' }),
  status: () => request<{ transactions: number; cardPayments: number; uploads: number; cards: number }>('/api/status'),
  transactions: () => request<Transaction[]>('/api/transactions'),
  cardPayments: () => request<CardPayment[]>('/api/card-payments'),
  cardStatements: () => request<CardStatement[]>('/api/card-statements'),
  categories: () => request<CategoryNode[]>('/api/categories'),
  /** "Change all": every payment to these names takes the category, now and in future. */
  categorizeShop: (payees: string[], category: string) =>
    request<{ updated: number; accounts: string[] }>('/api/categorize/shop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payees, category }),
    }),
  /** Payments you ticked, one by one: each takes the category as if set alone; their payee learns nothing (one payee
   *  can stand for several kinds of bill). `before` is how they were, for undoPayments. */
  categorizePayments: (transactionIds: string[], category: string) =>
    request<{ updated: number; before: PaymentState[] }>('/api/categorize/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionIds, category }),
    }),
  /** Puts payments back exactly as they were before categorizePayments. */
  undoPayments: (before: PaymentState[]) =>
    request<{ updated: number }>('/api/categorize/payments/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(before),
    }),
  /** Many payees at once, e.g. the whole review list. */
  categorizeBulk: (items: { payee: string; category: string; label?: string }[]) =>
    request<{ updated: number; confirmed: number; payees: number; remembered: number; accounts: number }>('/api/categorize/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
  /** Re-filing one payment also answers with the same shop's other payments (`related`), per name, and, when you
   *  ignored a transfer to a bank account not known to be yours, that account (`account`), to ask whether it is.
   *  A payee answer that made an account yours says so with `savedAs: 'account'` and its last four digits. */
  categorize: (body: { category: string; payee?: string; transactionId?: string; label?: string }) =>
    request<{
      updated: number
      savedAs: 'transaction' | 'payee' | 'merchant' | 'account'
      related?: { payee: string; count: number; already: number }[]
      account?: { last4: string; payee: string } | string | null
    }>('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  accounts: () => request<OwnAccount[]>('/api/accounts'),
  /** "Yes, it's mine": every transfer to or from this account is left out from now on. */
  claimAccount: (body: { transactionId?: string; payee?: string; label?: string }) =>
    request<{ account: OwnAccount; updated: number }>('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** "Not mine": its transfers count again. */
  forgetAccount: (last4: string) => request<{ updated: number }>(`/api/accounts/${last4}`, { method: 'DELETE' }),
  preferences: () => request<Preferences>('/api/preferences'),
  setPreferences: (changes: Partial<Preferences>) =>
    request<Preferences>('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }),
}

/** An export's extracted folder (Google Takeout), each file named by its path inside the folder. The server
 *  packs them into one zip, so it's stored and read like the zip itself. */
export function uploadFolder(files: File[], name: string, onProgress: (fraction: number) => void): Promise<UploadRecord> {
  const form = new FormData()
  for (const f of files) form.append('files', f, f.webkitRelativePath || f.name)
  form.append('name', name)
  return send('/api/uploads/folder', form, onProgress)
}

/** XHR rather than fetch so we get upload progress. */
export function uploadFile(
  file: File,
  kind: DeclaredKind,
  password: string | undefined,
  onProgress: (fraction: number) => void,
): Promise<UploadRecord> {
  const form = new FormData()
  form.append('file', file)
  form.append('kind', kind)
  if (password) form.append('password', password)
  return send('/api/uploads', form, onProgress)
}

function send(url: string, form: FormData, onProgress: (fraction: number) => void): Promise<UploadRecord> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let body: any = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadRecord)
      else reject(new ApiError(body?.detail?.message ?? `Failed (${xhr.status})`, body?.detail?.code, xhr.status))
    }
    xhr.onerror = () => reject(new ApiError("Couldn't reach the local server. Is it running?", 'network', 0))
    xhr.send(form)
  })
}
