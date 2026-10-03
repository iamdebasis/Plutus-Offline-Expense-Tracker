import { CardFace } from '../components/CardFace'
import { GALLERY } from '../components/cards/skins'

/** Every card design once, with sample data (no real cards), at /#card-gallery. Handy when adding a new design. */
export function CardGallery() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="mb-6 font-display text-2xl font-semibold tracking-tight">Card designs</h1>
      <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {GALLERY.map((c, i) => (
          <figure key={c.design}>
            <CardFace card={c} delay={i * 0.03} />
            <figcaption className="mt-2 text-xs text-zinc-500">
              {c.issuer} {c.product ?? ''} · <span className="font-mono">{c.design}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  )
}
