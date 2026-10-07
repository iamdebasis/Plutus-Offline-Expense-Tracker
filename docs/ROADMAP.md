# Roadmap

Where Plutus stands: ideas discussed and designed but not built, and the limits it has today. Pick up from here. Each
idea must keep the core values in [AGENTS.md](../AGENTS.md); [ARCHITECTURE.md](ARCHITECTURE.md) says where things go.

## Next, in order

The owner's list of upgrades, agreed on 7 October 2026. Each has its notes below.

1. ~~Bills paid, from statements~~: done; see [DECISIONS.md](DECISIONS.md) #19.
2. ~~One payment, one row~~: done; see [DECISIONS.md](DECISIONS.md) #20.
3. [Seasons in the rules](#seasons-in-the-rules): "last winter", "this monsoon" read without the local AI.
4. [Measure the suggested local models](#measure-the-suggested-local-models-on-plutuss-own-jobs): needs the model
   downloaded by its owner first; Plutus never downloads one.
5. [Ask Plutus, next](#ask-plutus-next): why questions, saved chats if wanted, actions from the chat.
6. ~~"Paid with" in the transactions list~~: done; see [DECISIONS.md](DECISIONS.md) #21.
7. [Page footers in payee names](#page-footers-in-payee-names): a statement reader bug.
8. [ICCL in the merchant list](#iccl-in-the-merchant-list): payments for mutual funds left uncategorized.

Each is done exactly: reproduced with fake data first, nothing assumed about a file or a name that a source or a
test hasn't shown.

## Discussed, not built

### Seasons in the rules

Ask Plutus reads "last winter", "this monsoon" or "the summer" only with the local AI, and in the measurement it was
the kind of question the model still got wrong ("What did I spend on cabs last winter?" read as top payees). Proposal:
India's seasons as periods in `web/src/lib/askRules.ts`, the same as the AI is told in `app/ask.py`: winter November to
February, summer March to June, monsoon July to September; "last winter" the latest one that has ended, "this
monsoon" or "the monsoon" the latest one that has begun. A season with a year ("winter 2025": which winter?) stays
unsure and goes to the AI. Tests in `web/tests/askRules.test.ts`.

### Page footers in payee names

Seen on a real statement (not copied here): a payee read as "<a merchant> <city> Page 16 of", and its row's full
wording ends "Page 16 of 19": the page's footer was taken into a row's description. Where it joins isn't known yet and
must be found, not guessed: reproduce it in `tests/fake_cards.py` (a statement whose footer "Page N of M" sits under a
page's last row, in each layout the readers know), see which step takes it in (`card_statement.read_rows`,
`shape_reader.py`, wrapped-line joining, or `clean_merchant`), fix it in general (a page's furniture never joins a
row), then follow the readers' procedure in [READERS.md](READERS.md): `make test`, `make measure` with nothing wrong or
unread, and `PARSER_VERSIONS` bumped so files read before are read again.

### ICCL in the merchant list

Payments to "ICCLGroww" (seen in a real UPI history; the names are public) are left Uncategorized. ICCL is the Indian
Clearing Corporation Ltd, a wholly owned subsidiary of BSE that clears and settles its segments, the mutual fund one
(StAR MF) included; brokers' mutual fund purchases are paid to it (sources:
[BSE](https://bseindia.com/downloads1/Indian_Clearing_Corporation_Limited.PDF),
[Zerodha](https://support.zerodha.com/category/mutual-funds/payments-and-orders/payment-methods/articles/add-funds-coin-new)).
So a payment to ICCL is an investment, whichever platform's name follows it. To do, each step checked rather than
assumed: how the name is written in each source (PhonePe, Google Pay, card and bank statements: "ICCL", "ICCLGroww",
"Indian Clearing Corporation"), an entry in `app/seed/merchants.json` under Investments with a test, and what money
back from ICCL (a redemption, or an order that wasn't allotted) counts as.

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
