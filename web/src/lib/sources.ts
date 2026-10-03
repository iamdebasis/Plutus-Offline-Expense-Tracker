import { CreditCard, ReceiptIndianRupee, ScanLine, Smartphone, type LucideIcon } from 'lucide-react'
import type { DeclaredKind, FileKind } from '../types'

export interface SourceMeta {
  kind: Exclude<DeclaredKind, 'auto'>
  title: string
  hint: string
  formats: string
  accept: string
  icon: LucideIcon
  iconClass: string
  glow: string
}

export const SOURCES: SourceMeta[] = [
  {
    kind: 'cc_statement',
    title: 'Credit card statements',
    hint: "Monthly statements (PDF), or the card's transactions exported from your bank's app or site",
    formats: 'PDF · CSV · XLSX',
    accept: '.pdf,application/pdf,.csv,.xlsx,.xls',
    icon: CreditCard,
    iconClass: 'bg-rose-400/10 text-rose-300 ring-rose-300/20',
    glow: 'rgb(251 113 133 / 0.12)',
  },
  {
    kind: 'cred_history',
    title: 'Card bill payments',
    hint: 'Payment history PDF from CRED. We find every card in it',
    formats: 'PDF',
    accept: '.pdf,application/pdf',
    icon: ReceiptIndianRupee,
    iconClass: 'bg-amber-400/10 text-amber-300 ring-amber-300/20',
    glow: 'rgb(251 191 36 / 0.11)',
  },
  {
    kind: 'upi_statement',
    title: 'UPI history',
    hint: 'PhonePe statement, or your Google Pay export from Google Takeout (the zip, or its folder)',
    formats: 'PDF · ZIP · FOLDER',
    accept: '.pdf,.zip,.html,.htm,.csv,.json',
    icon: Smartphone,
    iconClass: 'bg-violet-400/10 text-violet-300 ring-violet-300/20',
    glow: 'rgb(167 139 250 / 0.13)',
  },
  {
    kind: 'screenshot',
    title: 'Payment screenshots',
    hint: 'Any UPI app. We read the amount, payee and time',
    formats: 'PNG · JPG',
    accept: 'image/*',
    icon: ScanLine,
    iconClass: 'bg-sky-400/10 text-sky-300 ring-sky-300/20',
    glow: 'rgb(56 189 248 / 0.12)',
  },
]

export const KIND_LABEL: Record<DeclaredKind, string> = {
  auto: 'Auto-detect',
  cc_statement: 'Credit card',
  cred_history: 'CRED payments',
  upi_statement: 'UPI history',
  screenshot: 'Screenshot',
}

export const FILE_KIND_NOUN: Record<FileKind, [string, string]> = {
  cc_statement: ['credit card statement', 'credit card statements'],
  cred_history: ['CRED history', 'CRED histories'],
  upi_statement: ['UPI statement', 'UPI statements'],
  gpay_takeout: ['Google Pay export', 'Google Pay exports'],
  screenshot: ['screenshot', 'screenshots'],
  bank_statement: ['bank statement', 'bank statements'],
  unknown: ['unrecognised file', 'unrecognised files'],
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif']
const EXPORT_EXTS = ['zip', 'html', 'htm', 'csv', 'json', 'xlsx', 'xls']
export const SUPPORTED_EXTS = new Set(['pdf', ...IMAGE_EXTS, ...EXPORT_EXTS])
export const ACCEPT_ALL = [...SUPPORTED_EXTS].map((e) => `.${e}`).join(',')

export const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''

/** A file worth sending from an extracted Google Takeout folder: Google Pay's HTML, JSON and CSV files. */
export const isTakeoutFile = (f: File) => /(^|\/)google pay(\/|$)/i.test(f.webkitRelativePath) && /\.(html?|json|csv)$/i.test(f.name)
export const isImage = (name: string) => IMAGE_EXTS.includes(extOf(name))
export const isPdf = (name: string) => extOf(name) === 'pdf'

/** A first guess from the filename; the server's detection has the final say. */
export function guessKind(file: File, picked?: DeclaredKind): DeclaredKind {
  const name = file.name.toLowerCase()
  const ext = extOf(name)
  if (IMAGE_EXTS.includes(ext)) return 'screenshot'
  if (picked) return picked
  if (EXPORT_EXTS.includes(ext) || /phonepe|gpay|google.?pay|paytm|upi/.test(name)) return 'upi_statement'
  if (/(^|[^a-z])cred($|[^i])/.test(name)) return 'cred_history'
  if (/statement|credit.?card/.test(name)) return 'cc_statement'
  return 'auto'
}
