# Roadmap

Where Plutus stands: ideas discussed and designed but not built, and the limits it has today. Pick up from here. Each
idea must keep the core values in [AGENTS.md](../AGENTS.md); [ARCHITECTURE.md](ARCHITECTURE.md) says where things go.

## Discussed, not built

### Bills paid, from statements

The Credit cards section's "bills paid" comes only from a payment app's history (CRED and similar,
`data/card_payments.json`). Someone who adds only statements sees no bills paid, though every statement lists the
payment it received. Proposal: count a statement's bill payment row (`categorize.statement_bill`) as a bill paid when
no payment-app record exists for that card's cycle, matched by card, amount and date, so a payment is never counted
twice. Touches `app/billing.py`, `web/src/lib/ledger.ts` (`cardBillsPaid`), and the totals' tests.

### One payment, one row

Paying a card bill can appear three times: the statement's "PAYMENT RECEIVED", the UPI or bank payment that paid it,
and the payment app's bill record. Totals are right (none of them counts as spending), but the list shows the same
money up to three times. Proposal: link the sides (as `link_card_bills` already links a UPI payment to a CRED bill) and
show them as one payment with its sources. Touches `app/categorize.py`, `app/ledger.py`,
`components/dash/TransactionsTable.tsx`.

### Measure the suggested local models on Plutus's own jobs

The model suggestion (`app/llm/advice.py`) rests on published benchmarks and sizes, not on Plutus's own tasks. A
benchmark with fake data only would settle it: payee names with known categories (accuracy, JSON validity, speed),
generated statements (proven rate, time per part), fake receipts (fields right). Run it on the candidates for each
memory level, then adjust `SUGGESTED` and the memory levels. Needs the models downloaded by whoever runs it; never by
Plutus.

### Other ideas

- A reader for Google Pay's PDF statement (today its history comes through Google Takeout).
- Other UPI apps' screenshots read by OCR and rules, without the local AI.
- Linux: an OCR engine in place of Apple's Vision, plus Linux equivalents of the Trash (Start over) and of the Mac's
  facts the Local AI panel reads.

## Known limits

- **macOS only**: OCR is Apple's on-device Vision; the Trash and the Mac's facts come from macOS.
- **Local AI suggestion**: goes by total memory, not what's free; the memory levels are judgment; the 8 GB pick
  (`qwen3.5:2b`) sorts payees less well. Models Plutus doesn't know are listed as "not tested", never picked for you.
- **Screenshots**: PhonePe's layout is read by OCR and rules; other apps' receipts need the local AI's vision model.
- **Statements with nothing to check against** (an export with no totals or balances) can only be "agreed" (the rules
  and the AI read the same rows) or confirmed by you; long ones aren't sent to the AI (`UNCHECKED_PARTS`).
- **Card networks** are rarely printed on statements: the user sets them on the card.
- **Google Pay** history comes only through Google Takeout.
