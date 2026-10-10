# Roadmap

Where Plutus stands: ideas discussed and designed but not built, and the limits it has today. Pick up from here. Each
idea must keep the core values in [AGENTS.md](../AGENTS.md); [ARCHITECTURE.md](ARCHITECTURE.md) says where things go.

## Next, in order

The owner's list of upgrades, agreed on 7 October 2026. Each has its notes below.

1. ~~Bills paid, from statements~~: done; see [DECISIONS.md](DECISIONS.md) #19.
2. ~~One payment, one row~~: done; see [DECISIONS.md](DECISIONS.md) #20.
3. ~~Seasons in the rules~~: done; see [DECISIONS.md](DECISIONS.md) #22.
4. [Measure the suggested local models](#measure-the-suggested-local-models-on-plutuss-own-jobs): needs the model
   downloaded by its owner first; Plutus never downloads one.
5. [Ask Plutus, next](#ask-plutus-next): why questions (done, see [DECISIONS.md](DECISIONS.md) #23), then actions from
   the chat and saved chats if wanted, each to be agreed first.
6. ~~"Paid with" in the transactions list~~: done; see [DECISIONS.md](DECISIONS.md) #21.
7. ~~Page footers in payee names~~: done; reader version 14 (see [READERS.md](READERS.md), the Lines step).
8. ~~ICCL in the merchant list~~: done; categorising rules version 13 (`app/categorize.py`).

Each is done exactly: reproduced with fake data first, nothing assumed about a file or a name that a source or a
test hasn't shown.

## Discussed, not built

### Ask Plutus, next

The chat (see [ARCHITECTURE.md](ARCHITECTURE.md#ask-plutus)) answers what its query shape can express. Discussed next
steps, each keeping the rule that the AI reads the question and Plutus computes:

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
- **Money back from ICCL** under another name than the order's (the order paid to "ICCLGroww", the money back
  from "Indian Clearing Corporation") isn't matched to its order; it shows under Refunds, in money in. How each app
  names it hasn't been seen yet.
- **A bill that isn't a whole bill** (a part payment, an advance), from CRED or a statement, is placed like any bill:
  it stands for the cycle it's taken to pay.
- **Ask Plutus**: card spending known only from card bills has no category or payee, so questions about one leave it
  out (and say how much); the rules know English words only, and other languages rely on the local AI.
