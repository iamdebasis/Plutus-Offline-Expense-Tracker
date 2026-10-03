import { motion } from 'motion/react'
import { Check, Pencil } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { artFor, artUrl, useCardArt } from '../lib/cardArt'
import type { CardRef } from '../types'
import { Chip, NetworkMark, Wordmark } from './cards/parts'
import { skinFor } from './cards/skins'

const NETWORKS = ['Visa', 'Mastercard', 'RuPay', 'Diners Club', 'American Express']

interface Props {
  card: CardRef & { id?: string }
  badge?: ReactNode
  dim?: boolean
  delay?: number
  onSetNetwork?: (network: string | null) => void
  /** Clicking the card picks it (the card section then shows its spending); the network menu inside stays its own. */
  onSelect?: () => void
  /** Picked: ringed. */
  selected?: boolean
  className?: string
}

/** The card itself, the way CRED shows it: its bank's design (or your picture of it), the bank's wordmark, network and
 *  last digits, the chip. No numbers on the face; whatever the card is about goes underneath it.
 *  Everything inside scales with the card's width (container units). */
export function CardFace({ card, badge, dim, delay = 0, onSetNetwork, onSelect, selected, className = '' }: Props) {
  const [menu, setMenu] = useState(false)
  const uid = useId().replace(/:/g, '')
  const skin = skinFor(card)
  const art = artFor(card, useCardArt())
  const Art = skin.Background
  const tone = skin.tone ?? 'dark'
  const width = /(^|\s)w-/.test(className) ? '' : 'w-full' // a width from the caller wins

  const track = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`)
    e.currentTarget.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      // a card with no bills in the period recedes, faint and nearly colourless, and comes back in full on hover
      animate={{ opacity: dim ? 0.32 : 1, y: 0 }}
      transition={{ delay, type: 'spring', stiffness: 240, damping: 24 }}
      whileHover={{ y: -4, opacity: 1 }}
      onMouseMove={track}
      onMouseLeave={() => setMenu(false)}
      onClick={(e) => {
        if (onSelect && !(e.target as HTMLElement).closest('button, [role=menu]')) onSelect()
      }}
      // pickable with the keyboard too: Tab to it, Enter or Space
      {...(onSelect && {
        role: 'button',
        tabIndex: 0,
        'aria-pressed': !!selected,
        'aria-label': `${card.product ?? card.issuer ?? 'Card'} ••${card.last4}: ${selected ? 'showing its spending; press to show all cards' : 'show its spending'}`,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onSelect()
          }
        },
      })}
      // 1.75: a card's shape, so a picture of one shows whole
      className={`group @container relative isolate aspect-[1.75] ${width} overflow-hidden rounded-[10px] shadow-[0_14px_28px_-14px_rgb(0_0_0/0.9)] ${
        onSelect ? 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-white/50' : ''
      } ${selected ? 'ring-2 ring-white/80' : ''} ${className}`}
    >
      {/* the colour fade sits on the artwork, not on this frame: a filter here stops some browsers clipping the corners */}
      <div className={`absolute inset-0 transition-[filter] duration-500 ${dim ? 'saturate-[0.3] group-hover:saturate-100' : ''}`}>
        {art ? (
          <img src={artUrl(art)} alt="" loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <Art id={uid} />
        )}
      </div>

      {/* finish: a sheen that follows the pointer and a hairline edge */}
      <span
        aria-hidden
        className="absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'radial-gradient(45cqw circle at var(--mx, 30%) var(--my, 20%), rgb(255 255 255 / 0.16), transparent 60%)' }}
      />
      <span aria-hidden className="absolute inset-0 rounded-[10px] ring-1 ring-white/[0.1] ring-inset" />

      <div className="absolute top-[12%] left-[7%]">
        <Wordmark issuer={card.issuer} tone={tone} />
      </div>

      <div className={`absolute top-[39%] left-[7%] flex items-center gap-[2.4cqw] ${tone === 'light' ? 'text-zinc-800' : 'text-white/90 drop-shadow-[0_1px_2px_rgb(0_0_0/0.4)]'}`}>
        <NetworkMark network={card.network} tone={tone} />
        <span className="font-mono text-[4.6cqw] leading-none tracking-[0.18em]">•• {card.last4}</span>
      </div>

      <div className="absolute top-[58%] left-[7%]">
        <Chip tone={skin.chip} />
      </div>

      {badge && <div className="absolute top-[12%] right-[7%]">{badge}</div>}

      {onSetNetwork && (
        <>
          <button
            type="button"
            onClick={() => setMenu((m) => !m)}
            aria-label={`Set the card network for ${card.product ?? card.issuer ?? 'this card'}`}
            className="absolute top-[10%] right-[5%] flex size-[11cqw] items-center justify-center rounded-full bg-black/40 text-white/90 opacity-0 backdrop-blur transition group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="size-[5cqw]" />
          </button>
          {menu && (
            <div className="absolute inset-[3%] z-10 flex flex-col justify-center rounded-[8px] bg-black/80 px-1.5 py-1 backdrop-blur-md" role="menu">
              {[...NETWORKS, null].map((n) => (
                <button
                  key={n ?? 'none'}
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    onSetNetwork(n)
                    setMenu(false)
                  }}
                  className="flex items-center justify-between rounded-md px-1.5 py-[1px] text-left text-[11px] leading-tight text-white hover:bg-white/15"
                >
                  {n ?? "Don't know"}
                  {card.network === n && <Check className="size-3" />}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </motion.div>
  )
}
