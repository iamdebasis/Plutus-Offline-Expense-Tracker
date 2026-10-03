/** Same id the backend gives a card (app/vault.py instrument_id): issuer slug + last four digits. */
export function instrumentId(issuer: string | null, last4: string): string {
  const slug = (issuer ?? 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `card-${slug}-${last4}`
}
