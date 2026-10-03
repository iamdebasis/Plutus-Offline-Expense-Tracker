/** Small pieces of a card face: the EMV chip, network marks and bank wordmarks. Sizes are in container
 *  units (cqw) of the card, so they scale with it. `tone` is the card's surface: light cards get ink. */

import { useId } from 'react'

export type Tone = 'dark' | 'light'

export function Chip({ tone }: { tone: 'gold' | 'silver' }) {
  const id = useId().replace(/:/g, '')
  const [a, b, c] = tone === 'gold' ? ['#f6dc8c', '#d7aa4a', '#a97c26'] : ['#f1f1f1', '#c9c9c9', '#8d8d8d']
  return (
    <svg viewBox="0 0 46 36" className="w-[12.5cqw] drop-shadow-[0_1px_1px_rgb(0_0_0/0.35)]" aria-hidden>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="0.55" stopColor={b} />
          <stop offset="1" stopColor={c} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="45" height="35" rx="6.5" fill={`url(#${id}-g)`} stroke={c} strokeOpacity="0.7" />
      <g fill="none" stroke={c} strokeOpacity="0.75" strokeWidth="1.1" strokeLinecap="round">
        <path d="M0.5 12.5h11c3 0 4 2 4 5.5s-1 5.5-4 5.5h-11" />
        <path d="M45.5 12.5h-11c-3 0-4 2-4 5.5s1 5.5 4 5.5h11" />
        <path d="M15.5 18h15M23 0.5v7.5M23 28v7.5M17 8h12M17 28h12" />
      </g>
    </svg>
  )
}

/** Your frosted Mastercard mark, redrawn from its measurements: two frosted circles, a brighter lens
 *  where they overlap, a fine rim and a soft mint glow. */
function MastercardMark() {
  const id = useId().replace(/:/g, '')
  const r = 32
  const [c1, c2, cy] = [45, 86, 44]
  const h = Math.sqrt(r * r - ((c2 - c1) / 2) ** 2)
  const mx = (c1 + c2) / 2
  return (
    <svg viewBox="0 0 131 88" className="h-[6.4cqw] w-auto" aria-label="Mastercard" role="img">
      <defs>
        <filter id={`${id}-glow`} x="-30%" y="-40%" width="160%" height="180%">
          <feGaussianBlur stdDeviation="3.4" />
        </filter>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#edf2f2" />
          <stop offset="1" stopColor="#d5dddd" />
        </linearGradient>
      </defs>
      <g filter={`url(#${id}-glow)`} opacity="0.6" fill="#c3ebe2">
        <circle cx={c1} cy={cy} r={r + 1.5} />
        <circle cx={c2} cy={cy} r={r + 1.5} />
      </g>
      <circle cx={c1} cy={cy} r={r} fill={`url(#${id}-face)`} fillOpacity="0.93" />
      <circle cx={c2} cy={cy} r={r} fill={`url(#${id}-face)`} fillOpacity="0.93" />
      <path d={`M${mx} ${cy - h}A${r} ${r} 0 0 1 ${mx} ${cy + h}A${r} ${r} 0 0 1 ${mx} ${cy - h}Z`} fill="#f5f9f9" fillOpacity="0.9" />
      <g fill="none" stroke="#fff" strokeOpacity="0.6" strokeWidth="0.9">
        <circle cx={c1} cy={cy} r={r} />
        <circle cx={c2} cy={cy} r={r} />
      </g>
    </svg>
  )
}

export function NetworkMark({ network, tone = 'dark' }: { network: string | null; tone?: Tone }) {
  const ink = tone === 'light' ? '#0b2a2d' : '#fff'
  const cls = 'h-[5cqw] w-auto'
  switch (network) {
    case 'Visa':
      // Your Visa wordmark, cut from its artwork: white on dark cards, its own ink on light ones.
      return <img src={tone === 'light' ? '/brand/visa-ink.png' : '/brand/visa-white.png'} alt="Visa" className="h-[4.6cqw] w-auto" draggable={false} />
    case 'Mastercard':
      return <MastercardMark />
    case 'RuPay':
      return (
        <svg viewBox="0 0 70 18" className={cls} aria-label="RuPay" role="img">
          <text x="0" y="14.5" fill={ink} fontSize="16" fontWeight="800" fontStyle="italic" fontFamily="-apple-system, 'Helvetica Neue', Arial, sans-serif">
            RuPay
          </text>
          <path d="M57 2.5l6.5 6.5-6.5 6.5h3.4l6.5-6.5-6.5-6.5z" fill={ink} fillOpacity="0.9" />
          <path d="M53 2.5l6.5 6.5-6.5 6.5h3l6.5-6.5-6.5-6.5z" fill={ink} fillOpacity="0.55" />
        </svg>
      )
    case 'Diners Club':
      return (
        <svg viewBox="0 0 24 24" className={cls} aria-label="Diners Club" role="img">
          <circle cx="12" cy="12" r="10.5" fill="none" stroke={ink} strokeWidth="1.8" />
          <path d="M9.3 6.5v11M14.7 6.5v11" stroke={ink} strokeWidth="1.8" />
        </svg>
      )
    case 'American Express':
      return (
        <svg viewBox="0 0 44 24" className={cls} aria-label="American Express" role="img">
          <rect x="1" y="1" width="42" height="22" rx="3" fill="none" stroke={ink} strokeWidth="1.6" />
          <text x="22" y="16.5" fill={ink} fontSize="10.5" fontWeight="800" textAnchor="middle" letterSpacing="0.6" fontFamily="-apple-system, Arial, sans-serif">
            AMEX
          </text>
        </svg>
      )
    default:
      return null
  }
}

/** The bank's name as it sits on the card. */
export function Wordmark({ issuer, tone = 'dark' }: { issuer: string | null; tone?: Tone }) {
  const text = tone === 'light' ? 'text-zinc-900' : 'text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.35)]'

  switch (issuer) {
    case 'HDFC Bank':
      return (
        <span className={`inline-flex items-center gap-[1.4cqw] border-[0.5cqw] border-current px-[1.5cqw] py-[0.7cqw] ${text}`}>
          <svg viewBox="0 0 24 24" className="size-[5cqw]" aria-hidden>
            <rect x="2" y="2" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3" />
            <rect x="8.5" y="8.5" width="7" height="7" fill="currentColor" />
          </svg>
          <span className="text-[5.2cqw] leading-none font-black tracking-[0.02em]">HDFC BANK</span>
        </span>
      )
    case 'Axis Bank':
      return (
        <span className={`inline-flex items-end gap-[1.2cqw] ${text}`}>
          <svg viewBox="0 0 24 22" className="h-[6.6cqw]" aria-hidden>
            <path d="M11 0 22 20h-6.2L11 11.3 6.8 18.8H1z" fill="currentColor" />
            <path d="M13.5 15.5h8.5L24 20h-8.3z" fill="currentColor" />
          </svg>
          <span className="text-[5.4cqw] leading-none font-medium tracking-[0.04em]">AXIS BANK</span>
        </span>
      )
    case 'DBS Bank':
      return (
        <span className={`inline-flex items-center gap-[1.6cqw] ${text}`}>
          <svg viewBox="0 0 24 24" className="size-[7cqw]" aria-hidden>
            <rect width="24" height="24" fill="#e4002b" />
            <path d="M12 3.2 14.3 9.7l6.5 2.3-6.5 2.3L12 20.8l-2.3-6.5L3.2 12l6.5-2.3z" fill="#fff" transform="rotate(45 12 12)" />
          </svg>
          <span className="font-serif text-[8cqw] leading-none font-semibold tracking-[-0.03em]">DBS</span>
        </span>
      )
    case 'SBI Card':
      return (
        <span className={`inline-flex items-center gap-[1.4cqw] ${text}`}>
          <svg viewBox="0 0 24 24" className="size-[6.4cqw]" aria-hidden>
            <circle cx="12" cy="12" r="11" fill="#fff" />
            <circle cx="12" cy="10.5" r="3.2" fill="#1a6e38" />
            <rect x="10.9" y="11" width="2.2" height="12" fill="#1a6e38" />
          </svg>
          <span className="text-[7.4cqw] leading-none font-black tracking-[-0.02em]">
            SBI <span className="font-medium text-sky-300">card</span>
          </span>
        </span>
      )
    case 'Federal Bank':
    case 'OneCard':
      return (
        <span className={`inline-flex items-center text-[9cqw] leading-none font-black tracking-[-0.04em] ${text}`} aria-label="OneCard">
          <span className="mr-[0.4cqw] inline-flex size-[8cqw] items-center justify-center rounded-full bg-current text-[5.8cqw]">
            <span className={tone === 'light' ? 'text-white' : 'text-black'}>1</span>
          </span>
          ne
        </span>
      )
    case 'IndusInd Bank':
      return <span className={`text-[6.6cqw] leading-none font-bold tracking-[-0.02em] italic ${text}`}>IndusInd Bank</span>
    case 'ICICI Bank':
      return (
        <span className={`inline-flex items-center gap-[1.4cqw] ${text}`}>
          <svg viewBox="0 0 24 24" className="size-[6.4cqw]" aria-hidden>
            <ellipse cx="12" cy="12" rx="11" ry="10" fill="#fff" transform="rotate(-20 12 12)" />
            <circle cx="13.5" cy="6.8" r="1.8" fill="#f58220" />
            <path d="M12.8 10.5 10.3 18.5" stroke="#b02a30" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span className="text-[6cqw] leading-none font-bold">ICICI Bank</span>
        </span>
      )
    default:
      return <span className={`text-[6cqw] leading-none font-semibold ${text}`}>{issuer ?? 'Credit card'}</span>
  }
}
