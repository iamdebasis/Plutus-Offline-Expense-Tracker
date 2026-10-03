import { useCallback, useReducer, useRef } from 'react'
import { ApiError, api, uploadFile, uploadFolder } from '../api'
import type { DeclaredKind, UploadRecord } from '../types'
import { peekPdf } from './pdfPeek'
import { guessKind, isImage, isPdf } from './sources'

/** `known`: the same file (by content) is already in the vault, or earlier in this list. It isn't sent. */
export type ItemStatus = 'ready' | 'known' | 'uploading' | 'importing' | 'done' | 'duplicate' | 'error'
export type Phase = 'select' | 'processing' | 'done'

export interface Item {
  id: string
  file: File
  kind: DeclaredKind
  preview?: string // object URL for images, data URL for PDF thumbnails
  pages?: number
  locked?: boolean
  password?: string
  sha256?: string
  knownAs?: { name: string; uploadedAt?: string; inList?: boolean }
  status: ItemStatus
  progress: number
  result?: UploadRecord
  error?: { message: string; code?: string }
  /** An export's extracted folder (Google Takeout): its files, sent together and packed into one zip. `file` is
   *  then just a stand-in carrying the folder's name. */
  folder?: { files: File[]; bytes: number }
}

interface State {
  items: Item[]
  phase: Phase
  /** Items of the current run still to be sent to the server. */
  sending: string[]
}

type Action =
  | { type: 'add'; items: Item[] }
  | { type: 'patch'; id: string; patch: Partial<Item> }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'send'; ids: string[] }
  | { type: 'sent'; id: string }
  | { type: 'sync'; uploads: UploadRecord[] }

const FINAL = new Set(['done', 'failed', 'skipped'])
const EMPTY: State = { items: [], phase: 'select', sending: [] }

/** A run is done once every file is sent and read. */
function settle(state: State): State {
  if (state.phase !== 'processing' || state.sending.length) return state
  return state.items.some((i) => i.status === 'uploading' || i.status === 'importing') ? state : { ...state, phase: 'done' }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'add':
      // files added mid-run wait for the next one; after a finished run they start a fresh list
      if (state.phase === 'processing') return { ...state, items: [...state.items, ...action.items] }
      return { ...EMPTY, items: [...(state.phase === 'done' ? [] : state.items), ...action.items] }
    case 'patch':
      return settle({ ...state, items: state.items.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i)) })
    case 'remove':
      return { ...state, items: state.items.filter((i) => i.id !== action.id) }
    case 'clear':
      return EMPTY
    case 'send':
      // everything in the run shows as on its way, even while it waits for a free slot
      return {
        ...state,
        phase: 'processing',
        sending: action.ids,
        items: state.items.map((i) => (action.ids.includes(i.id) ? { ...i, status: 'uploading', progress: 0, error: undefined } : i)),
      }
    case 'sent':
      return settle({ ...state, sending: state.sending.filter((id) => id !== action.id) })
    case 'sync': {
      const byId = new Map(action.uploads.map((u) => [u.id, u]))
      let changed = false
      const items = state.items.map((item): Item => {
        const rec = item.status === 'importing' && item.result ? byId.get(item.result.id) : undefined
        // uploadedAt guards against a stale answer about an earlier copy of the same file
        if (!rec || rec.uploadedAt !== item.result!.uploadedAt) return item
        const st = rec.importStatus?.state
        if (!st || !FINAL.has(st)) {
          if (rec.importStatus?.step === item.result!.importStatus?.step) return item
          changed = true
          return { ...item, result: rec }
        }
        changed = true
        return st === 'failed'
          ? { ...item, result: rec, status: 'error', error: { message: rec.importStatus?.error ?? 'Reading this file failed' } }
          : { ...item, result: rec, status: 'done' }
      })
      return changed ? settle({ ...state, items }) : state
    }
  }
}

const fingerprint = (f: File) => `${f.name}:${f.size}:${f.lastModified}`
const CONCURRENCY = 2

interface Options {
  /** The vault as last seen, to recognise files added before. */
  vault: () => UploadRecord[] | null
  /** Each file the server accepted, so its reading can be followed. */
  onUploaded: (record: UploadRecord) => void
}

export function useSelection({ vault, onUploaded }: Options) {
  const [state, dispatch] = useReducer(reducer, EMPTY)
  const stateRef = useRef(state)
  stateRef.current = state
  const opts = useRef({ vault, onUploaded })
  opts.current = { vault, onUploaded }

  const patch = useCallback((id: string, p: Partial<Item>) => dispatch({ type: 'patch', id, patch: p }), [])

  /** Returns how many files were skipped because they were already in the list. */
  const add = useCallback(
    (files: File[], picked?: DeclaredKind): number => {
      const current = stateRef.current.phase === 'done' ? [] : stateRef.current.items
      const listed = new Set(current.map((i) => fingerprint(i.file)))
      const fresh: Item[] = []
      for (const file of files) {
        if (listed.has(fingerprint(file))) continue
        listed.add(fingerprint(file))
        fresh.push({
          id: crypto.randomUUID(),
          file,
          kind: guessKind(file, picked),
          preview: isImage(file.name) ? URL.createObjectURL(file) : undefined,
          status: 'ready',
          progress: 0,
        })
      }
      if (stateRef.current.phase === 'done') releasePreviews(stateRef.current.items)
      dispatch({ type: 'add', items: fresh })
      for (const item of fresh) {
        if (isPdf(item.file.name)) {
          peekPdf(item.file).then((peek) => patch(item.id, { preview: peek.thumb, pages: peek.pages, locked: peek.locked }))
        }
        recognise(item)
      }
      return files.length - fresh.length
    },
    [patch],
  )

  /** An extracted export folder, as one item. Returns false if that folder is already in the list. */
  const addFolder = useCallback((name: string, files: File[]): boolean => {
    const current = stateRef.current.phase === 'done' ? [] : stateRef.current.items
    if (current.some((i) => i.folder && i.file.name === name && i.folder.files.length === files.length)) return false
    if (stateRef.current.phase === 'done') releasePreviews(stateRef.current.items)
    const item: Item = {
      id: crypto.randomUUID(),
      file: new File([], name),
      kind: 'upi_statement',
      folder: { files, bytes: files.reduce((s, f) => s + f.size, 0) },
      status: 'ready',
      progress: 0,
    }
    dispatch({ type: 'add', items: [item] })
    return true
  }, [])

  /** Same content as a file in the vault, or one earlier in this list? Then there's nothing to send. */
  const recognise = async (item: Item) => {
    const hash = await sha256(item.file)
    if (!hash) return
    const stored = opts.current.vault() ?? (await api.uploads().catch(() => []))
    const now = stateRef.current.items.find((i) => i.id === item.id)
    if (!now || now.status !== 'ready') return
    const inVault = stored.find((u) => u.sha256 === hash)
    const earlier = stateRef.current.items.find((i) => i.id !== item.id && i.sha256 === hash && i.status !== 'known')
    const knownAs = inVault
      ? { name: inVault.originalName, uploadedAt: inVault.uploadedAt }
      : earlier
        ? { name: earlier.file.name, inList: true }
        : undefined
    patch(item.id, knownAs ? { sha256: hash, status: 'known', knownAs } : { sha256: hash })
  }

  const remove = useCallback((id: string) => {
    const item = stateRef.current.items.find((i) => i.id === id)
    if (item) releasePreviews([item])
    dispatch({ type: 'remove', id })
  }, [])

  const clear = useCallback(() => {
    releasePreviews(stateRef.current.items)
    dispatch({ type: 'clear' })
  }, [])

  const sync = useCallback((uploads: UploadRecord[]) => dispatch({ type: 'sync', uploads }), [])

  /** Sends the files; resolves once they're stored. Reading them carries on in the background and
   *  arrives through `sync`. */
  const process = useCallback(async () => {
    const queue = stateRef.current.items.filter((i) => i.status === 'ready' || i.status === 'error')
    if (!queue.length) return
    dispatch({ type: 'send', ids: queue.map((i) => i.id) })

    const run = async (item: Item) => {
      if (item.status === 'error' && item.result) {
        // stored fine, reading it failed: read it again rather than send it again
        patch(item.id, { status: 'importing', error: undefined })
        try {
          const rec = await api.reimport(item.result.id)
          patch(item.id, { result: rec })
          opts.current.onUploaded(rec)
        } catch (err) {
          patch(item.id, { status: 'error', error: { message: (err as Error).message } })
        }
        return
      }
      patch(item.id, { status: 'uploading', progress: 0, error: undefined })
      try {
        const onProgress = (p: number) => patch(item.id, { progress: p })
        const result = item.folder
          ? await uploadFolder(item.folder.files, item.file.name, onProgress)
          : await uploadFile(item.file, item.kind, item.password, onProgress)
        patch(item.id, { status: result.duplicate ? 'duplicate' : 'importing', progress: 1, result })
        if (!result.duplicate) opts.current.onUploaded(result)
      } catch (err) {
        const e = err as ApiError
        patch(item.id, {
          status: 'error',
          progress: 0,
          error: { message: e.message, code: e.code },
          // a wrong or missing password means the file is locked, whatever pdf.js thought
          locked: e.code === 'wrong_password' || e.code === 'password_required' ? true : item.locked,
        })
      }
    }

    const pending = [...queue]
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
        for (let item = pending.shift(); item; item = pending.shift()) {
          await run(item)
          dispatch({ type: 'sent', id: item.id })
        }
      }),
    )
  }, [patch])

  return { ...state, add, addFolder, remove, clear, patch, process, sync }
}

async function sha256(file: File): Promise<string | null> {
  if (!crypto.subtle) return null // only in secure contexts; 127.0.0.1 and localhost are
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

function releasePreviews(items: Item[]) {
  for (const i of items) if (i.preview?.startsWith('blob:')) URL.revokeObjectURL(i.preview)
}
