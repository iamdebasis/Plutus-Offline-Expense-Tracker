# Roadmap

Where Plutus stands: ideas discussed and designed but not built, and the limits it has today. Pick up from here. Each
idea must keep the core values in [AGENTS.md](../AGENTS.md); [ARCHITECTURE.md](ARCHITECTURE.md) says where things go.

## Next, in order

The owner's list of upgrades, agreed on 7 October 2026. Each has its notes below.

1. ~~Bills paid, from statements~~: done; see [DECISIONS.md](DECISIONS.md) #19.
2. [One payment, one row](#one-payment-one-row): a card bill's sides shown as one payment.
3. [Seasons in the rules](#seasons-in-the-rules): "last winter", "this monsoon" read without the local AI.
4. [Measure the suggested local models](#measure-the-suggested-local-models-on-plutuss-own-jobs): needs the model
   downloaded by its owner first; Plutus never downloads one.
5. [Ask Plutus, next](#ask-plutus-next): why questions, saved chats if wanted, actions from the chat.

## Discussed, not built

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

### Seasons in the rules

Ask Plutus reads "last winter", "this monsoon" or "the summer" only with the local AI, and in the measurement it was
the kind of question the model still got wrong ("What did I spend on cabs last winter?" read as top payees). Proposal:
India's seasons as periods in `web/src/lib/askRules.ts`, the same as the AI is told in `app/ask.py`: winter November to
February, summer March to June, monsoon July to September; "last winter" the latest one that has ended, "this
monsoon" or "the monsoon" the latest one that has begun. A season with a year ("winter 2025": which winter?) stays
unsure and goes to the AI. Tests in `web/tests/askRules.test.ts`.

### Ask Plutus, next

The chat (see [ARCHITECTURE.md](ARCHITECTURE.md#ask-plutus)) answers what its query shape can express. Discussed next
steps, each keeping the rule that the AI reads the question and Plutus computes:

- **Why questions**: "why was March higher?" answered as a difference by category and payee between two periods
  (a new kind in `lib/ask.ts`, worked out like `compare`).
- **Saved chats**, only if wanted: kept in the data folder (a new file listed in `app/userdata.py`, removed by Start
  over), never in the browser's storage.
- **Actions from the chat**: "file these under Groceries", shown as the change it would make and done only when you
  confirm it, through the same routes the dashboard uses.
- **Measure the question reading** on the suggested models: fake questions with known queries, part of the model
  measurement above.

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
- **A bill that isn't a whole bill** (a part payment, an advance), from CRED or a statement, is placed like any bill:
  it stands for the cycle it's taken to pay.
- **Ask Plutus**: card spending known only from card bills has no category or payee, so questions about one leave it
  out (and say how much); the rules know English words only, and other languages rely on the local AI.
