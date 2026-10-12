# Release notes

What each version of Plutus holds, how it was checked before release, and what it can't do yet. Plans and ideas are
in [ROADMAP.md](ROADMAP.md), the reasons behind the design in [DECISIONS.md](DECISIONS.md).

## 1.0.0 · 12 October 2026

The first release: everything below works on a Mac with no internet connection, with or without the optional local
AI.

### What's in it

**Reading your files**
- PhonePe statements, CRED payment history, Google Pay history from Google Takeout (a zip, or its folder), UPI payment
  screenshots, and any bank's credit card statement or its CSV and Excel exports. A password-protected PDF asks for
  its password once; it is never saved.
- A card statement counts only when its own arithmetic proves every row (previous balance − credits + debits = total
  due, to the paisa, or a running balance). One that can't be proven is held, counting nothing, until you check its
  rows in Your vault against the PDF's page. A year's download is split into its statements, each proven on its own.
- A file added twice is skipped, even under a new name. Deleting a file takes out every payment read only from it.

**Counting every rupee once**
- One payment in several files (a RuPay card on UPI, a card bill in CRED and in your UPI history) is kept once.
- Every side of a card bill payment points to its bill, and the transactions list shows it as one row.
- A month with only a bill and no statement gets its card spending estimated from the bill, less what's already
  counted, placed in the cycle the bill paid for. The UPI section plus the card section always equals Total spend.

**The dashboard**
- Total spend by category, Month by month (a chart, and a table with a row a category and a column a month), Credit
  cards, UPI spends, and Your transactions: search, the payees waiting for an answer, a change to several payments at
  once with Undo, and how each was paid.
- Tap a category in Total spend to see where its money went: its top payees, its sub-categories together, and its
  biggest payments, with **Show all** opening them in Your transactions. A shop is one row however your files spell it
  ("BLINKIT GURGAON" on a statement, "Blinkit" in a UPI app). Uncategorized lists its payees with a category picker
  each; Card purchases shows the bills its estimate comes from. With nothing tapped: your biggest payment, top payee,
  busiest month, the year against the one before, and one thing to do.
- Investments can be counted or left out with one switch; every figure follows it.
- Ask Plutus: questions in your own words, answered with the dashboard's own figures and the payments behind them.
- The page widens with the window, works on a phone with nothing scrolling sideways, reads at 4.5:1 contrast or more,
  and follows the Mac's Increase contrast and Reduce motion settings.

**Privacy**
- The server listens on this Mac only (`127.0.0.1`), refuses other host names and writes from other sites, and the
  page loads nothing from the internet.
- The local AI (Ollama, optional) is the only AI. It sorts payees and reads questions and unproven statements; it
  never sees a transaction when reading a question, and never decides a figure. Plutus never downloads a model or
  installs anything.
- Everything about you is in `data/`. Start over moves it all to the Trash, and Plutus is a fresh install again.

### How it was checked

Every check below ran on made-up data only (the tests' generated statements and the demo's year), never on anyone's
own files.

| Check | Result |
|---|---|
| `make test`: backend tests, with the network blocked | 386 passed |
| `make test`: the dashboard's arithmetic, Ask Plutus's answers, contrast | 129 passed |
| `make test`: TypeScript | no errors |
| `make measure`: 1000 random fake card statements | 926 proven, 74 held (they print nothing to check them by), none wrong, none unread |
| `make check-ui`: the page in a headless browser, on the demo | 482 passed, none failed |
| The demo's figures recounted from the API outside the page (rent, groceries, shopping, UPI) | the same as the page's, to the rupee |
| A running server: Start over or a read from another site, another host name, this Mac's Wi-Fi address | all refused |
| The repository and its history: names, card or account digits, real statements | none found |

`make check-ui` covers, on the demo: the ledger through the API (each payment well formed, traced to its file and
counted once; each bill placed and estimated to the paisa; each proven statement closing); every figure shown in more
than one place agreeing, for each year with investments counted or left out, and Ask Plutus giving the same; the
page's width from 1280 to 2560 pixels; the month tables; what Total spend shows for every category you tap (its
payees and bills add up to it, **Show all** opens exactly its payments); phones and small windows; contrast and tap
targets; and a walkthrough that starts over, adds the files again with the file picker, answers a payee from Total
spend and another from the review list, changes two payments and undoes it, confirms a held statement and deletes a
file, checking the ledger after each. Two things were also broken
on purpose, on a scratch copy, to see the checks fail: card bill payments left unlinked to their bills, and helper text
dimmed below 4.5:1. Both were caught; so were a category's payees no longer taking their refunds off.

Fixed while checking:
- A Google Takeout zip with a file too big to be Google Pay's (a "zip bomb") is no longer unpacked; that file is
  reported unreadable and the rest is read.
- The demo's card statements now receive each bill on the day it was paid, as a bank's would, so the demo's UPI
  payments of those bills link to them.
- A few entries of the merchant list name a kind of payee rather than one shop (electricity boards, metros, gas
  companies). Two such companies were treated as one shop when you re-filed a payment; they're two payees now, and
  are still filed the same way.

### Known limits

- **macOS only.** Reading scans and screenshots uses Apple's on-device OCR; Start over uses the Mac's Trash.
- **Statements with nothing to check against** (an export with no totals or balances) wait for you to confirm them,
  or for the local AI to read the same rows as the rules.
- **Screenshots**: PhonePe's are read by OCR and rules; other apps' need the local AI's vision model.
- **Google Pay** history comes only through Google Takeout, not its PDF statement.
- **Card networks** (Visa, RuPay…) are rarely printed on statements: you set them on the card.
- **The month table** fits a year without scrolling while each month is under ₹1 lakh; on a phone it always scrolls,
  with the names pinned.
- **Ask Plutus** leaves out card spending known only from a bill (it has no category or payee) and says how much; its
  rules read English, and other languages rely on the local AI.
- **The local AI suggestion** goes by the Mac's total memory, not what's free.
- **One shop, however it's spelt**: numbers in a name are taken for store codes, so two local shops whose names differ
  only by a number show as one payee (it says how else it's spelt).

The full list, with what's planned, is in [ROADMAP.md](ROADMAP.md).

### Getting it

```bash
git clone https://github.com/iamdebasis/Plutus-Offline-Expense-Tracker.git
cd Plutus-Offline-Expense-Tracker
git checkout v1.0.0
make setup
make start      # http://127.0.0.1:8000
```

Already running Plutus? Stop it, `git pull`, `make setup`, `make start`. Your `data/` folder is kept as it is.
