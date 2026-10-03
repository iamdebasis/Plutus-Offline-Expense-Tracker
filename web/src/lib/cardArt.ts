import { useEffect, useState } from 'react'
import { api } from '../api'

/** Pictures of your own cards, from data/card-art/, named after the bank and card your statements name:
 *  "hdfc-bank--fake-rewards.jpg" for an HDFC Bank card named "Fake Rewards", "hdfc-bank.jpg" for one named only by
 *  its bank. Any case, any separators; JPG, PNG or WebP. Like the rest of your data, they never leave data/. */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Which of the pictures is this card's: the one for its card (the longest name its product contains), or the
 *  bank's when the statement names only the bank. A named card never gets another card's picture, nor its bank's. */
export function artFor(card: { issuer: string | null; product: string | null }, names: string[]): string | null {
  const bank = slug(card.issuer ?? '')
  if (!bank) return null
  const product = letters(card.product ?? '')
  const pictures = names
    .map((name) => {
      const [b, c] = name.replace(/\.[a-z]+$/i, '').split('--')
      return { name, bank: slug(b), card: c === undefined ? null : letters(c) }
    })
    .filter((p) => p.bank === bank)
  if (!product) return pictures.find((p) => p.card === null)?.name ?? null
  const own = pictures.filter((p) => p.card && product.includes(p.card)).sort((a, b) => b.card!.length - a.card!.length)
  return own[0]?.name ?? null
}

export const artUrl = (name: string) => `/api/card-art/${encodeURIComponent(name)}`

let pictures: Promise<string[]> | null = null

/** The pictures in data/card-art/, asked for once per page load (add one, then reload). */
export function useCardArt(): string[] {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    pictures ??= api.cardArt().catch(() => [])
    void pictures.then((n) => alive && setNames(n))
    return () => {
      alive = false
    }
  }, [])
  return names
}
