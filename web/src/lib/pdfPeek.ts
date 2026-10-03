export interface PdfPeek {
  thumb?: string
  pages?: number
  locked?: boolean
}

let queue: Promise<unknown> = Promise.resolve()

/** First-page thumbnail + page count, rendered locally. One PDF at a time so the UI stays smooth. */
export function peekPdf(file: File, width = 112): Promise<PdfPeek> {
  const job = queue.then(() => render(file, width))
  queue = job.catch(() => undefined)
  return job
}

async function render(file: File, width: number): Promise<PdfPeek> {
  // pdf.js is large, so it's only loaded once someone actually picks a PDF.
  const pdfjs = await import('pdfjs-dist')
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  let doc
  try {
    doc = await task.promise
  } catch (err) {
    await task.destroy()
    if ((err as Error)?.name === 'PasswordException') return { locked: true }
    return {}
  }
  try {
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: width / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    return { thumb: canvas.toDataURL('image/jpeg', 0.82), pages: doc.numPages }
  } catch {
    return { pages: doc.numPages }
  } finally {
    await task.destroy()
  }
}
