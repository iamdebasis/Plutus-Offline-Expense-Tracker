import { useId } from 'react'

/** The Plutus mark: a gold graffiti dollar sign, paint dripping off it. When `animated`, the drips
 *  stretch, drops fall and a gleam crosses the gold now and then (all off for reduced motion).
 *  The static version of the same drawing is public/favicon.svg. */
export function PlutusLogo({ className = 'size-9', animated = false, title = 'Plutus' }: { className?: string; animated?: boolean; title?: string }) {
  const id = useId().replace(/:/g, '')
  const s = `${id}-s`
  const bar = `${id}-bar`
  const gold = `${id}-gold`
  const mask = `${id}-mask`
  const shine = `${id}-shine`
  const drip = animated ? 'plutus-drip' : undefined
  const drop = animated ? 'plutus-drop' : undefined

  return (
    <svg viewBox="0 0 64 64" className={className} {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      <defs>
        <path id={s} d="M45 19C41 11.5 23 11 21 20 19 28.5 30 30.5 33 32 37 34 46.5 37 44 45.5 41.5 53.5 24 53 19 45" />
        <path id={bar} d="M32 4.5V58" />
        {/* anchored to the canvas: a gradient relative to a zero-width line renders nothing */}
        <linearGradient id={gold} gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58">
          <stop offset="0" stopColor="#ffdc6e" />
          <stop offset="0.5" stopColor="#f7b32d" />
          <stop offset="1" stopColor="#e8921a" />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id={mask}>
          <use href={`#${s}`} fill="none" stroke="#fff" strokeWidth="10" strokeLinejoin="round" />
          <use href={`#${bar}`} fill="none" stroke="#fff" strokeWidth="7" />
        </mask>
      </defs>

      {/* extrusion shadow */}
      <g transform="translate(2.2 2.2)" fill="none" stroke="#1c0f04" strokeLinejoin="round">
        <use href={`#${s}`} strokeWidth="14" />
        <use href={`#${bar}`} strokeWidth="10.5" />
      </g>

      {/* S: outline, drips (paint running over the edge), gold, shade, highlight */}
      <use href={`#${s}`} fill="none" stroke="#2a1606" strokeWidth="14" strokeLinejoin="round" />
      <g fill={`url(#${gold})`} stroke="#2a1606" strokeWidth="1.3">
        <path className={drip} style={{ animationDelay: '0s' }} d="M24.4 54v5.4a1.6 1.6 0 0 0 3.2 0V54z" />
        <path className={drip} style={{ animationDelay: '-1.1s' }} d="M37.3 53.2v3.6a1.5 1.5 0 0 0 3 0v-3.6z" />
        <path className={drip} style={{ animationDelay: '-2.2s' }} d="M42.3 22v4.6a1.5 1.5 0 0 0 3 0V22z" />
      </g>
      <g fill="#f7b32d" stroke="#2a1606" strokeWidth="1.1">
        <circle className={drop} style={{ animationDelay: '0s' }} cx="26" cy="62.3" r="1.1" />
        <circle className={drop} style={{ animationDelay: '-2.2s' }} cx="43.8" cy="29.6" r="0.95" />
      </g>
      <use href={`#${s}`} fill="none" stroke={`url(#${gold})`} strokeWidth="10" strokeLinejoin="round" />
      <use href={`#${s}`} transform="translate(1.6 1.6)" fill="none" stroke="#dd7d18" strokeWidth="3.2" strokeLinejoin="round" opacity="0.8" />
      <use href={`#${s}`} transform="translate(-1.9 -2.1)" fill="none" stroke="#fff4c4" strokeWidth="1.3" strokeLinejoin="round" strokeDasharray="16 6 5 30" opacity="0.9" />

      {/* bar, in front, with its own drip */}
      <use href={`#${bar}`} fill="none" stroke="#2a1606" strokeWidth="10.5" />
      <path className={drip} style={{ animationDelay: '-0.6s' }} d="M30.4 57v4.4a1.6 1.6 0 0 0 3.2 0V57z" fill={`url(#${gold})`} stroke="#2a1606" strokeWidth="1.2" />
      <use href={`#${bar}`} fill="none" stroke={`url(#${gold})`} strokeWidth="7" />
      <use href={`#${bar}`} transform="translate(1.4 0)" fill="none" stroke="#dd7d18" strokeWidth="2.2" opacity="0.8" />
      <path d="M30.2 8V20" stroke="#fff4c4" strokeWidth="1.2" strokeLinecap="round" opacity="0.9" />

      {/* the gleam: a soft light band crossing the gold, only where there is gold */}
      {animated && (
        <g mask={`url(#${mask})`}>
          {/* tilt on the group: a CSS animation's transform would replace one on the rect itself */}
          <g transform="rotate(18 32 32)">
            <rect className="plutus-shine" x="-24" y="-8" width="12" height="80" fill={`url(#${shine})`} />
          </g>
        </g>
      )}
    </svg>
  )
}
