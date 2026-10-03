/** Card designs, one "skin" per bank, matched by the bank your statements name. They're the same for everyone and
 *  say nothing about which cards anyone has (your cards live in data/instruments.json). A picture of your own card,
 *  if you add one (data/card-art/, lib/cardArt.ts), is shown instead. Drawn on a 344×200 canvas (CRED's
 *  proportions). */

import type { ReactNode } from 'react'

export interface Skin {
  key: string
  chip: 'gold' | 'silver'
  /** A colour that glows behind the card grid. */
  glow: string
  /** The bank and product this design is for, as a sample card in the gallery. */
  sample: { issuer: string; product: string | null }
  /** Light surfaces get ink-coloured text and logos. */
  tone?: 'dark' | 'light'
  Background: (props: { id: string }) => ReactNode
}

function Canvas({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 344 200" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden>
      {children}
    </svg>
  )
}

function Fill({ id, stops, angle = 'diag' }: { id: string; stops: [number, string][]; angle?: 'diag' | 'down' | 'across' }) {
  const [x2, y2] = angle === 'down' ? [0, 1] : angle === 'across' ? [1, 0] : [1, 1]
  return (
    <>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2={x2} y2={y2}>
          {stops.map(([o, c]) => (
            <stop key={o} offset={o} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      <rect width="344" height="200" fill={`url(#${id}-fill)`} />
    </>
  )
}

/** Fine horizontal streaks, like brushed metal. */
function Brushed({ id, strength = 0.1 }: { id: string; strength?: number }) {
  return (
    <>
      <defs>
        <filter id={`${id}-brush`} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.003 0.9" numOctaves="2" seed="7" />
          <feColorMatrix type="matrix" values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  ${strength} 0 0 0 0`} />
        </filter>
      </defs>
      <rect width="344" height="200" filter={`url(#${id}-brush)`} />
    </>
  )
}

// ---- the designs -------------------------------------------------------------------------------

function IndusIndWaves({ id }: { id: string }) {
  const paper = `url(#${id}-paper)`
  const land = '#4a82c8'
  return (
    <Canvas>
      <defs>
        <filter id={`${id}-paper`} x="-10%" y="-30%" width="120%" height="160%">
          <feDropShadow dx="0" dy="-2.5" stdDeviation="3.2" floodColor="#04122b" floodOpacity="0.6" />
        </filter>
      </defs>
      <Fill id={id} stops={[[0, '#2a5a9c'], [1, '#163768']]} />
      <path d="M0 0H128C100 22 70 34 48 64S12 104 0 116Z" fill="#214d8a" filter={paper} />
      <path d="M0 0H72C56 18 38 32 22 54S6 82 0 88Z" fill="#265695" filter={paper} />
      {/* each landmark stands on the paper layer in front of it */}
      <g fill={land} opacity="0.85" filter={paper}>
        <path d="M165 12L167 38 171 62 176 84 183 116H175C172 104 168 100 165 100S158 104 155 116H147L154 84 159 62 163 38Z" />
        <rect x="157" y="60" width="16" height="3" />
        <rect x="152" y="82" width="26" height="3" />
        <path d="M230 84L233 50Q234 42 238 42T243 50L246 84Z" />
        <circle cx="238" cy="38" r="3.6" />
        <path d="M241.5 46L248 22" stroke={land} strokeWidth="3.2" strokeLinecap="round" />
        <path d="M246 15.5h5l-1.4 6h-2.2z" />
      </g>
      <path d="M0 96C50 70 95 120 150 100S250 60 344 88V200H0Z" fill="#1f4783" filter={paper} />
      <g fill={land} opacity="0.8" filter={paper}>
        <path d="M190 132c-2-18 2-30 8-36-10-2-20 4-22 12 6-3 10-2 12 0-4 4-5 12-4 24zM210 134c-1-15 2-24 7-30-8-2-16 3-18 10 5-2 8-2 10 0-3 3-4 10-3 20z" />
        <ellipse cx="198" cy="94" rx="15" ry="7" />
        <ellipse cx="216" cy="104" rx="12" ry="6" />
      </g>
      <path d="M0 130C60 112 110 152 175 134S290 106 344 126V200H0Z" fill="#1b407a" filter={paper} />
      <g fill={land} opacity="0.8" filter={paper}>
        <g transform="rotate(7 300 150)">
          <rect x="292" y="100" width="17" height="56" rx="2" />
          <path d="M292 112h17M292 124h17M292 136h17" stroke="#1b407a" strokeWidth="1.2" />
        </g>
        <path d="M18 124q27 11 56 0-6 10-28 10t-28-10z" />
        <path d="M51 122l-10-22" stroke={land} strokeWidth="1.6" />
      </g>
      <path d="M0 162C70 144 125 180 195 164S300 144 344 160V200H0Z" fill="#18396e" filter={paper} />
    </Canvas>
  )
}

const STAR = 'M0-100C10-28 28-10 100 0 28 10 10 28 0 100-10 28-28 10-100 0-28-10-10-28 0-100Z'

function DbsStars({ id }: { id: string }) {
  return (
    <Canvas>
      <Fill id={id} stops={[[0, '#a3a3a3'], [1, '#868686']]} />
      <path d={STAR} transform="translate(34 158) rotate(45) scale(1.55)" fill="#7a7a7a" opacity="0.4" />
      <path d={STAR} transform="translate(24 16) rotate(45) scale(0.95)" fill="#7a7a7a" opacity="0.28" />
      <g transform="translate(162 100)">
        <rect x="-26" y="-26" width="52" height="52" rx="4" fill="#6f6f6f" opacity="0.38" />
        <path d={STAR} transform="rotate(45) scale(0.27)" fill="#a8a8a8" />
      </g>
    </Canvas>
  )
}

function AxisShards({ id }: { id: string }) {
  return (
    <Canvas>
      <Fill id={id} stops={[[0, '#b30c4d'], [1, '#8f0739']]} />
      <path d="M-20 200L118-16 196 104 132 200Z" fill="#000" opacity="0.1" />
      <path d="M150 200L214 96H330L262 200Z" fill="#000" opacity="0.08" />
      <path d="M118-16L196 104 232 48 170-40Z" fill="#fff" opacity="0.04" />
    </Canvas>
  )
}

function OneCardTwoTone({ id }: { id: string }) {
  return (
    <Canvas>
      <defs>
        <radialGradient id={`${id}-low`} cx="0.5" cy="0.25" r="0.85">
          <stop offset="0" stopColor="#474747" />
          <stop offset="1" stopColor="#141414" />
        </radialGradient>
      </defs>
      <rect width="344" height="200" fill={`url(#${id}-low)`} />
      <rect width="344" height="84" fill="#0b0b0b" />
      <rect y="83.5" width="344" height="1" fill="#fff" opacity="0.05" />
    </Canvas>
  )
}

function SbiSwirls({ id }: { id: string }) {
  return (
    <Canvas>
      <defs>
        <pattern id={`${id}-sw`} width="42" height="42" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="#fff" strokeOpacity="0.08" strokeWidth="1.1" strokeLinecap="round">
            <path d="M21 30c-7 0-10-5-8-10s9-6 11-1-2 7-5 5" />
            <path d="M4 4l5 7 5-7M9 11v7" />
            <path d="M30 6c4 3 4 8 0 10" />
          </g>
        </pattern>
      </defs>
      <Fill id={id} stops={[[0, '#23833f'], [0.6, '#15602c'], [1, '#0c451e']]} angle="across" />
      <rect width="344" height="200" fill={`url(#${id}-sw)`} />
    </Canvas>
  )
}

function HdfcNavy({ id }: { id: string }) {
  return (
    <Canvas>
      <Fill id={id} stops={[[0, '#1a3f7a'], [1, '#0b1f42']]} />
      <path d="M120 200L220 0H262L162 200Z" fill="#fff" opacity="0.05" />
      <path d="M176 200L276 0H300L200 200Z" fill="#fff" opacity="0.035" />
      <circle cx="300" cy="30" r="90" fill="#3d6fc0" opacity="0.12" />
    </Canvas>
  )
}

function IciciEmber({ id }: { id: string }) {
  return (
    <Canvas>
      <Fill id={id} stops={[[0, '#9e2a2b'], [1, '#4d1010']]} />
      <path d="M0 150C80 110 160 190 344 120V200H0Z" fill="#f58220" opacity="0.12" />
    </Canvas>
  )
}

function Graphite({ id }: { id: string }) {
  return (
    <Canvas>
      <Fill id={id} stops={[[0, '#4a4e57'], [1, '#1f2227']]} />
      <Brushed id={id} strength={0.08} />
    </Canvas>
  )
}

// ---- matching ----------------------------------------------------------------------------------

const SKINS: Record<string, Skin> = {
  indusind: { key: 'indusind', sample: { issuer: 'IndusInd Bank', product: null }, chip: 'gold', glow: '#2a5a9c', Background: IndusIndWaves },
  dbs: { key: 'dbs', sample: { issuer: 'DBS Bank', product: null }, chip: 'silver', glow: '#8a8a8a', tone: 'light', Background: DbsStars },
  axis: { key: 'axis', sample: { issuer: 'Axis Bank', product: null }, chip: 'silver', glow: '#b30c4d', Background: AxisShards },
  onecard: { key: 'onecard', sample: { issuer: 'OneCard', product: null }, chip: 'silver', glow: '#3c3c3c', Background: OneCardTwoTone },
  sbi: { key: 'sbi', sample: { issuer: 'SBI Card', product: null }, chip: 'silver', glow: '#23833f', Background: SbiSwirls },
  hdfc: { key: 'hdfc', sample: { issuer: 'HDFC Bank', product: null }, chip: 'silver', glow: '#1a3f7a', Background: HdfcNavy },
  icici: { key: 'icici', sample: { issuer: 'ICICI Bank', product: null }, chip: 'gold', glow: '#9e2a2b', Background: IciciEmber },
  graphite: { key: 'graphite', sample: { issuer: 'Other bank', product: null }, chip: 'silver', glow: '#4a4e57', Background: Graphite },
}

/** Which design a card gets: its bank's, or graphite for a bank without one. */
export function skinFor(card: { issuer: string | null; product: string | null }): Skin {
  const issuer = card.issuer ?? ''
  const product = (card.product ?? '').toLowerCase()
  if (issuer === 'OneCard' || /\bone ?card\b/.test(product)) return SKINS.onecard
  if (issuer === 'Federal Bank') return product ? SKINS.graphite : SKINS.onecard // CRED lists a OneCard by its bank
  const byBank: Record<string, Skin> = {
    'IndusInd Bank': SKINS.indusind,
    'DBS Bank': SKINS.dbs,
    'Axis Bank': SKINS.axis,
    'SBI Card': SKINS.sbi,
    'HDFC Bank': SKINS.hdfc,
    'ICICI Bank': SKINS.icici,
  }
  return byBank[issuer] ?? SKINS.graphite
}

/** Every design once, as a sample card for the gallery page (#card-gallery): the bank and product it's for, no
 *  network, no real digits. Built from the designs, so it lists designs, never anyone's cards. */
export const GALLERY = Object.values(SKINS).map((skin) => ({ ...skin.sample, network: null, last4: '0000', design: skin.key }))
