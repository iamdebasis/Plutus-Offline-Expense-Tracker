# Release notes

What each version of Plutus holds, how it was checked before release, and what it can't do yet. Plans and ideas are
in [ROADMAP.md](ROADMAP.md), the reasons behind the design in [DECISIONS.md](DECISIONS.md).

## Added since 1.0.0 · not in a release yet

Where you were, told to Ask Plutus, with its state. Still version 1.0.0: these become a version's notes when one is
made.

### What's new

- **Tell Ask Plutus where you were**, in your own words: "I was in Goa from 1st Jan 2026 to 5th March 2026", "Coorg
  trip 12-19 March", "I'm in Goa since 1 Oct", "I'll be in Goa from 20 to 25 Dec". It shows what that would do (the
  days, the payments on them, what you spent, and any days it takes from a place told before) and keeps nothing until
  you press its button; *Undo* takes it back. "Forget Goa" works the same way. Days the rules can't place exactly
  ("the second week of March") are read by the local AI if it's set up; otherwise Ask Plutus asks for the days.
- **Places**, a new section between UPI spends and Your transactions: a card for each place with what you spent there,
  a day's average and the top categories, with *Show payments*, *Edit*, *Remove* (and *Undo*), and *Add a place*.
- **A Location column** in Your transactions, after Payee (beside the day on a phone), a *Place* filter, and the search
  finds a place.
- **A place's state**: "Darjeeling, WB", written with the place (its number-plate code, or its name after a comma) and
  kept as written. Without one, Ask Plutus offers the state you gave that place before. Otherwise, with the local AI
  set up, it asks the AI about the place's name alone, never a payment or the rest of the sentence. You get its usual
  spelling and state (*Mark as Mumbai, MH*, "you wrote “Mambaii”"), a button for each state when a name is in several
  (Aurangabad: Maharashtra, Bihar), and always *Keep as written*. Places' *Edit* has a State list. Nothing is
  downloaded: India's 36 states and union territories are a fixed table in Plutus.
- **Ask Plutus answers about places**: "How much did I spend in Goa?", "Goa by category", "How much did I spend in West
  Bengal?", "Where was I in February?".
- A place changes no payment and no figure: your places are kept apart from the ledger (`data/places.json`), and each
  payment's place comes from its day. A statement for those days added later shows the place too.
- **Ask Plutus closes with a click outside it**, as well as with ✕ or Escape: it slides away, and what you clicked
  still works. A click inside it, a window it opened, or selecting its text past its edge keeps it open.
- **Money in reads clearly**: a received payment's row says "Received", then "from" whom, and under Paid with's chips
  "Credited to account ••1111" (or the card it went back to), as a bank's statement does; payments out are unchanged.
  Every row of the list is the same height, money in included.
- **Search Your transactions by category**: type `bar`, `food`, `shop` (or `liquor`, `kirana`, `petrol`…) and the list
  shows that category's payments, a main category with everything under it, alongside payees with the word in their
  name; a chip for each category named, with how many, narrows the list to it.
- **A stopwatch while your files are read**: the reading pill shows how long the run has taken so far, from the server's
  own times (so a reload doesn't reset it), and when it's done, how long it took ("5 files read in 4m 12s"), with each
  file's own time in its list.
- **Start over leaves nothing of yours behind**, still sending it all to the Trash:
  - Plutus never lets your browser cache an answer about you.
  - The page forgets how its panels were left the moment the server confirms.
  - Plutus open in another tab loads again, empty.
  - The server forgets the local model you chose.
- **Ask Plutus never gets more power than a button on the dashboard**: what it offers from the chat is what a button
  does, through the same route, shown first, done by your click, and undoable.

### How it was checked

| Check | Result |
|---|---|
| `make test`: backend tests, with the network blocked | 411 passed |
| `make test`: the dashboard's arithmetic, Ask Plutus, places and states, Start over, reading time, search by category, how money in reads, contrast | 227 passed |
| `make test`: TypeScript | no errors |
| `make measure`: 1000 random fake card statements | 926 proven, 74 held (they print nothing to check them by), none wrong, none unread |
| `make check-ui`: the page in a headless browser, on the demo | 551 passed, none failed |

Among them: a place's spending is the same in its Places card, in Ask Plutus, and counted independently from the
API; the Location column names the place on exactly its days; telling a stay keeps nothing until its button, a typed
"yes" changes nothing, Undo and Remove put things back exactly, and the ledger is byte for byte the same afterwards.
Each rule (the latest place told wins a shared day, a refund takes its payment's day, questions aren't read as stays,
a time to come is the next one, a state written after a place, codes only in capitals, the local AI's answer about a
place checked) was switched off once and its test failed. The local AI's place cards (one suggestion, a name in two states, a place it
doesn't know, checking) were looked at in the browser with a stand-in for the AI, on a desktop and a phone: every text
reads and every control reaches.

### Known limits

- One place a day: a day trip and home on the same day can't be split.
- Card spending known only from bills has no days, so it gets no place; a place's card and answers say about how much
  of it falls on its days.
- The rules read English and the date forms above; other wordings need the local AI, or the days said again.
- Without the local AI, a place's spelling isn't checked and its state is only what you write. A state's code is read
  only in capitals ("up", "as" and "or" are words), and "London, UK" reads as Uttarakhand (the card names the state
  before you keep it).

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
