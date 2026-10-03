# Plutus guide

Everything about using Plutus: what it reads, how it counts, where your data lives. For what Plutus is and how it's
built, see the [README](../README.md).

- [Requirements](#requirements) · [Run it](#run-it) · [Your data stays yours](#your-data-stays-yours)
- [What happens to a file](#what-happens-to-a-file) · [What the terminal tells you](#what-the-terminal-tells-you)
- [How the numbers add up](#how-the-numbers-add-up) · [Credit cards](#credit-cards) ·
  [Credit card statements](#credit-card-statements) · [Google Pay](#google-pay-from-google-takeout)
- [Where things live](#where-things-live) · [Card designs](#card-designs) · [Local AI](#local-ai-optional) · [Tools](#tools)

## Requirements

- **macOS**: screenshots and scanned PDFs are read with Apple's on-device OCR (Vision).
- **Python 3.12+**: macOS's own `python3` is older; `brew install python@3.13`.
- **Node 22.18+ and pnpm**, to build and test the UI: `brew install node pnpm`.
- **Optional: [Ollama](https://ollama.com)**, a local AI that sorts payees no rule recognises (see [Local AI](#local-ai-optional)).
  Without it everything works; those payees wait for you in "Needs your eyes".

`make check` tells you what's missing and how to get it.

## Run it

```bash
make setup        # once: checks your Mac, installs the Python and web packages, turns on the commit guard
make start        # build the UI and serve everything at http://127.0.0.1:8000
make dev          # or: hot reload (UI on http://127.0.0.1:5173)
make demo         # a made-up year of spending at http://127.0.0.1:8001, in .demo/ (never data/)
make test         # backend tests (no network allowed), the dashboard's money checks, TypeScript
make screenshots  # the README's pictures, taken from the demo (needs Chrome, Brave, Edge or Chromium)
```

Open http://127.0.0.1:8000 and add your first files. The app starts empty and learns as you go: your cards, your
payees, your answers to "Needs your eyes".

## Your data stays yours

- Everything about you lives in `data/` in this folder, and nowhere else (see [Where things live](#where-things-live)):
  your original files, transactions, cards, own accounts, payee table, corrections and settings. A fresh clone has no
  `data/`; it's created as you use the app, so every copy of Plutus is personal to whoever runs it.
- The code holds only what's the same for everyone: the category tree, the merchant dictionary (public businesses),
  card designs and the rules that read statements. Nothing in it is about a particular person: no names, no account
  or card digits, no choices. Every module reaches `data/` through `backend/app/userdata.py`, which lists every file,
  and a test fails if code goes around it or carries a real-looking account number.
- `data/` is in `.gitignore`, as are statements, exports and screenshots anywhere in the project. `make setup` also
  turns on a commit guard (`scripts/git-hooks/pre-commit`) that refuses them even when forced (`git add -f`), so
  pushing your fork can't publish your finances.
- The server listens only on `127.0.0.1`. The UI loads nothing from the internet (no CDN, fonts or analytics), and the
  only other address the app talks to is a local Ollama, which must be on `127.0.0.1` too.
- Tests use fake data only, and fail on any network connection that isn't `127.0.0.1`.
- To start over, stop the app and delete `data/`.

## What happens to a file

1. **Checked before it's sent**: the page hashes each file you pick (SHA-256, in the browser) and flags any you added
   before, even renamed, so they're skipped. The server checks the hash again on arrival.
2. **Stored and identified** in `data/uploads/`, sorted by kind. Password-protected PDFs are unlocked once; the
   password is never saved.
3. **Read in the background**, from the most exact source available:
   - the PDF's own text layer, when it reads normally (PhonePe);
   - **decoded** text when the PDF's fonts are scrambled (CRED). On-device OCR (Apple Vision) serves as the key to
     rebuild the character table, and every amount must agree between the decoded text and OCR;
   - on-device OCR for screenshots and scans, with the local vision model as the fallback for unfamiliar layouts.

   You can close the file sheet meanwhile. A pill in the dashboard's sticky year bar shows "Reading 2 of 5 files" and the
   current step (click it for each file), a gold line fills as files finish, and the numbers update as each file lands.
   When the run ends the pill says what was added and what needs review, and stays until you dismiss it.
4. **Deduplicated** into the ledger by UTR, then the app's transaction ID, then time + amount + payee. Different
   references are always different payments (two ₹15 teas in a minute are two teas), and a different amount is never
   the same payment (a cashback shares its payment's ID). The same UTR, amount and direction is always one payment,
   even under two app IDs: PhonePe sometimes lists a refund twice ("Refund Received - …" and "Payment Received").
   Every transaction has its own ID, even a payment and its refund that share every reference.
5. **Categorized**, cheapest and most certain first: your payee table → your corrections → your own accounts →
   card bills → merchant dictionary → earlier AI answers → keyword rules → the local AI (once per new name, remembered).
   Anything it isn't sure of lands in **Needs your eyes**. Answer a payee once and it holds for all their payments,
   past and future: a person you put a name to ("Water delivery") goes into your payee table; anything else is
   remembered as your correction. "Looks right for all" saves the whole list as shown, your edits included, after a
   confirm. The panel collapses to one line and remembers that.

| Source | Status |
|---|---|
| PhonePe statement PDF | ✅ every transaction, incl. split card + gift-card payments and cashback |
| CRED payment history PDF | ✅ every card bill payment; discovers your cards |
| UPI screenshots | ✅ PhonePe layout by OCR; other apps via the optional local AI |
| Google Pay history (Google Takeout) | ✅ every completed payment, merged across the export's folders ([below](#google-pay-from-google-takeout)) |
| Credit card statements, any bank | ✅ every purchase, fee, payment, refund and cashback, checked against the bank's own totals ([below](#credit-card-statements)) |
| Credit card exports (CSV, Excel, PDF) | ✅ the bank's export of any span, matched with your statements ([below](#exports-of-a-span)) |

### Big files

There's no page limit, only a 50 MB upload cap. A fake all-time PhonePe statement of 700 pages (10 MB, 6,300 payments,
2016–2026) took 4 seconds to read and save; the dashboard showed it right away. The local AI then needs about a second
per payee name it hasn't seen (331 names: 6 minutes), once: after that the name is remembered. Names in your payee table
and known merchants skip it. Overlapping statements (yearly ones plus an all-time one) are fine: repeats are matched by
UTR and counted once.

## What the terminal tells you

One line per meaningful event, tagged by area. OCR is cyan, the local AI is magenta, warnings are yellow.
File names, counts and timings only; never your transactions.

| Tag | You'll see |
|---|---|
| `startup` | data folder, ledger size, whether Ollama and the model are available |
| `upload` | each file: size, what it was identified as, cards found, duplicates, unlocking |
| `read` / `ocr` / `decode` | whether a PDF's own text was used or on-device OCR ran (pages, lines, seconds), and how the scrambled-font decode checked out |
| `parse` / `ledger` | what was found, how it was read, amounts confirmed, new vs already known |
| `category` | where categories came from (payee table, known merchants, rules, AI) and your corrections |
| `llm` | Ollama starting and stopping, each model call (purpose, seconds, model load time, tokens), sleeping after idle |

## How the numbers add up

**Total spend** (top of the dashboard) is cards and UPI together, counted once:
- UPI spending by category, a card used on UPI included: it was a UPI payment, whichever file it was learned from
  (the UPI app's history, or the card's statement);
- purchases with a card's number, from your **card statements** and the bank's exports, one by one, in their
  categories, on the day you bought;
- for card bills that pay no statement you added, *card purchases* estimated from the bill (CRED history): the bill,
  less what's already counted one by one in the billing cycle it paid for (UPI payments made with that card, and any
  part of the cycle an export lists). What's left is card spending that can't be itemized, shown per card and counted
  in that cycle, spread over its days, so December's spending stays in December when the bill is paid in January. A
  bill that pays a statement you added, or a cycle an export lists whole, adds nothing.

The UPI section and the Credit cards section add up to Total spend exactly, for every year and card; the frontend's
tests (`web/tests/totals.test.ts`) check it.

The line under the sum says which parts are in it. The ring gives the six biggest categories
(across all years) a colour each, so a category keeps its colour whichever year you pick; the rest are "Other".

**Month by month** (below it) draws each category's spending per month, from the same numbers. Tick the categories to
draw; the scale fits what's ticked, so one category on its own shows its real ups and downs. Your ticks are
remembered. Card purchases is dashed: it's estimated, spread over the billing cycles the bills paid for. A month no
file covers is a gap, not ₹0. Seven categories have colours (the ring's six plus violet); others are grey and named at
their line's end, since lines can cross anywhere and more colours would be too close to tell apart.

- **Spent**: payments for things and services, minus what was refunded (below).
- **Sent to people**: UPI to individuals. Label a person once (e.g. "Water delivery") and they move into spending.
- **Card bills paid**: from CRED. Settles card spending, so it's never added to "Spent" (no double counting).
  Paying a bill in the CRED app with PhonePe shows up in both files: the bill in your CRED history and a UPI payment
  to "CRED" / "CRED Club" / "CredClub" / Dreamplug in PhonePe. The UPI side is always a card bill, never spending, and
  is linked to its bill (same minute, same amount, or up to 5% less when CRED rewards paid part of it), so the
  transactions list says which card it paid. The bill is counted once, in the Credit cards section.
- **Investments** (SIPs, brokers, mutual funds): the **Count investments** switch next to the years decides. Off
  (the default, for when you track investments elsewhere) leaves them out of everything: every total, chart, list,
  the transactions table and "Needs your eyes", with refunds of them too; the bar under the years says how much
  ("Investments: ₹X left out"). Card bills still know about investments paid with a card on UPI and take them off
  card purchases, so they never come back in that way. On counts them as spending, in their own category. Colours
  don't change either way. Your choice is kept in `data/settings.json`; until you make one it follows the
  category tree, which marks investments as not spending.
- **Money in**: credits, cashback, and refunds whose payment isn't in your files.
- **Refunds** ("Refund from …", or money from a known shop such as Swiggy) are matched to the payment they give back:
  by the app's transaction ID, else the latest earlier payment to the same shop within 180 days that has enough left
  to refund. A matched refund is subtracted from that payment's category, dated with the payment (refunding December's
  order in January lowers December), so a failed-then-reversed payment counts as nothing. An unmatched refund (paid by
  card, or before your first statement) stays in Money in rather than lowering spending that was never counted.
- **Ignored**: left out entirely, in both directions. The payments stay in the ledger but count nowhere; "Show
  ignored" in the transactions table reveals them. Set it per payee from any category dropdown.
- **Your own accounts**: money moved between them isn't spending. Accounts you pay from are recognised from your
  statements ("Debited from XX1234"). Any other account of yours (the one you pay rent from, the one your SIPs leave
  from) becomes yours when you say so: answer its payee with **Ignored** in "Needs your eyes", or ignore one transfer
  in the transactions list and answer **Yes, it's mine** when asked. Every transfer to or from it is then left out,
  whichever way a statement names it ("Bank Account XXXXXX1234", "XXXX1234", "…1234@HDFC0001234.ifsc.npci"). It's
  kept in `data/accounts.json` with its last four digits only, never the account number. They're listed under
  **Paid from → Also yours**, where **Not mine** undoes it. An account you pay rent *to* (your landlord's) is the
  opposite: give it a category such as Rent, and add a name if you like; that goes to your payee table.
- **Who you paid most** lists people and shops, never card bills: a bill pays your own card, and what the card bought
  is in the Credit cards section.

When the categorization rules or your payee table change (`RULES_VERSION` in `app/categorize.py`, or
`data/payees.json` edited by hand), the app re-applies them to the whole ledger on its next start. Your own
choices are never overwritten.

## Credit cards

Each card shows what was spent with its number in the selected year: read one by one from its statements, plus what
its bills say for the months without one. What you paid with it on UPI is in UPI spends and noted under the card
("+ ₹2,100 on UPI"). Click a card to see only its spending; cards with nothing in the year are greyed out. Below the
cards, the same breakdown the UPI section has, for all cards or one: spent, bills paid, per month, fees and interest,
refunds and cashback; month by month, one line per card with the same chips, hover and table as Total spend's chart
(solid where your statements are read, dashed where a bill's estimate is all there is, a gap where no file covers the
month; what you paid with a card on UPI is noted in the hover); where it went, the biggest purchases, and the shops
you used the cards at most.

**Billing cycles** (`backend/app/billing.py`). A bill pays one cycle of purchases: the statement it pays. One statement
of a card is enough to learn its billing day (banks bill on the same day each month), and every bill of that card is
then placed in the cycle it paid. For a card with no statement yet, cycles are taken to end about ten days before its
bills are usually paid, and say so.

**Which card a UPI payment was made with.** UPI apps write a credit card as "XXXX" and its last two digits. It's the
card of yours ending that way; if two do, the RuPay one (only RuPay credit cards work on UPI), and never a card set to
another network. When it's still not clear, the payment isn't given to either card, and the Paid from list says so:
set the RuPay card's network on its card face and it's matched.

### Credit card statements

Add any bank's monthly statement PDF (password-protected ones ask for the password once; it's never saved). One
reader handles every bank: it finds the transactions table by its header's meaning ("Date", "Transaction details",
"Description", "Particulars", "Amount"…), takes the columns from where the header sits, and reads each row: a row starts
with a date and ends with an amount; a line without a date continues the description above. Credits are recognised
by "Cr", "CR", "C", "+"/"-", a credits column or a credits section; reward points tables, EMI schedules and terms are
skipped. Columns the header names around the description and amount are kept out of them: a transaction ID or
reference before the description, cash or reward points after the amount. The summary's own labels ("Statement Date |
Payment Due Date | Total Amount Due") are never taken for the table's header, and the terms pages' worked examples
(an illustration of interest, with dates and figures of its own) are never rows or figures. A balance or a due is
money (paise or a ₹), so a cash points box's "Previous Balance" or "Closing Balance" beside it isn't mistaken for it.
A statement with no header it knows is read line by line. The tests read generated statements in the shapes of Axis,
HDFC, ICICI and SBI statements and seven other layouts (signs instead of Cr, no header, separate debit and credit
columns, times and reward points beside rows, add-on cards, a statement across the new year with no years in its
dates…); a new bank usually just works.

**Every statement is checked against the bank's own figures**: previous balance − credits + debits must equal the total
due, to the rupee. The import summary and the Credit cards section say whether it adds up; one that doesn't is still
imported, with how far apart it is, so a misread never hides.

What each row becomes:

| Row | Becomes |
|---|---|
| a merchant (debit) | a purchase on that card: the name cleaned ("PYU*SHOP BANGALORE" → SHOP), sorted by your answers, known merchants, then the bank's own category column as a hint ("RESTAURANTS"), then keywords and the local AI. A card purchase is never filed as a person |
| PAYMENT RECEIVED / BBPS / AUTOPAY | your bill payment: Credit card bills, never spending or money in |
| a merchant (credit), REFUND, REVERSAL | a refund, taken off the purchase it refunds |
| CASHBACK, REWARD | cashback (money in) |
| forex markup, GST, late, annual or joining fee, interest | Fees & Charges (counted as spending) |
| an EMI conversion or instalment | Ignored: the purchase counted when you made it; EMI interest is a fee |
| cash withdrawal | Cash |

A purchase paid over UPI with the card ("UPI-SHOP-shop@okbank") is a UPI payment, counted in UPI spends. A RuPay card
used on UPI shows up in both your UPI statement and the card's statement; the two are matched (same card, amount, and
a day either way) and kept as one payment, whichever file comes first. A Google purchase charged to the card is
matched the same way. Adding a statement again, or a better reader re-reading it, adds nothing twice (your answers
stay), and a row an earlier reading made up is dropped. A statement a reader couldn't read is tried again,
automatically, when the reader improves. Deleting it removes its rows and its record, and the bill it covered counts
again. If a statement reads wrong, `make inspect FILE=...` shows its layout with every name and number masked; when
its rows don't add up, its entry in Your vault shows the figures behind the check and the lines of its table that
weren't read as rows.

### Exports of a span

The card's transactions exported from the bank's app or site, over any span, work too: CSV, Excel (.xlsx, or the HTML
table some banks save as .xls) and PDFs. Columns are found by what their headers mean; credits by a Dr/Cr column or
mark, separate debit and credit columns, or a sign (the sign your payments carry is the credits'). A purchase that a
statement of yours also lists is counted once, even when the export dates it when it posted (up to three days later)
or names the shop its own way. A bill for a cycle an export lists whole adds no estimate; for a cycle it lists part
of, what it lists comes off the estimate. An export that doesn't print its card number is taken to be your only card
of that bank, and says so.

## Google Pay (from Google Takeout)

Google Pay has no download for your whole history; Google Takeout does. On takeout.google.com choose **Deselect all**,
tick **Google Pay**, then **Next step → Create export**, and add the zip Google emails you, or unzip it and choose the
folder (the folder button in the file sheet). A folder is packed into one zip on arrival, the same bytes every time, so
it's stored, recognised as a repeat and read exactly like the zip.

| In the export | What Plutus does with it |
|---|---|
| My Activity (HTML or JSON) | The main source: one transaction per completed payment ("Paid ₹250.00 to … using Bank Account XXXX1234") |
| Money sends and requests | Merged into My Activity's entries (adds the transaction ID and memo); payments it lacks are added; requests are skipped |
| Google transactions | Purchases from Google (Play, YouTube, Google One): added, unless My Activity already has them |
| Rewards earned | Cashback (money in), merged with the matching "Received" entry; vouchers without cash are skipped |
| Group expenses | Split-bill notes, not money that moved: counted, never added |
| Anything else | Listed as "Not read" in the import summary, so nothing is dropped silently |

Only completed payments count; failed, pending, cancelled and refunded ones are counted in the summary and left out.
Topping up UPI Lite moves your own money, so it's ignored; payments made with UPI Lite or a RuPay credit card are
recorded with that as "Paid from". The import summary lists, per folder, what was read and what became of it.

If the counts look wrong, `make inspect-takeout FILE=~/Downloads/takeout.zip` (or the folder) prints the export's
structure with every name, amount and ID masked and dates reduced to their format, so it's safe to share.

The Google Pay app can also make a PDF statement (Transaction history → ⋮ → Get Statement, up to a year at a time) with
UPI transaction IDs on every row; a reader for it would be a separate addition.

## Where things live

| Path | What |
|---|---|
| `data/uploads/` | Your original files, sorted into `credit-card-statements/`, `cred/`, `upi/`, `screenshots/`… |
| `data/uploads.json` | One record per file: hash, what was detected, import result |
| `data/ledger/<year>.json` | Every transaction, flat, one file per calendar year |
| `data/card_payments.json` | Credit card bill payments, and the billing cycle each paid for |
| `data/instruments.json` | Cards discovered from statements and CRED history |
| `data/card_networks.json` | The network you set for each card; survives deleting the files that found it |
| `data/card_statements.json` | Your card statements and exports: period, due date, the bank's totals, and whether the rows add up |
| `data/accounts.json` | Your own bank accounts, last four digits only, so transfers between them are left out |
| `data/payees.json` | Your payee table: people and accounts you pay, e.g. "R Kumar" → Water delivery, your landlord → Rent |
| `data/merchant_memory.json` | Your corrections and the local AI's earlier answers, per payee name |
| `data/settings.json` | Your settings: whether investments count as spending |
| `data/state.json` | Housekeeping: which rules your ledger was last sorted with |
| `data/run/` | Files being received, the tools' temporary copies, the local AI's process id and log |
| `data/redacted/` | Anonymised copies made by `make redact` |
| `data/card-art/` | Pictures of your cards you added, shown on their card faces ([below](#card-designs)) |
| `backend/app/seed/` | Not yours: the category tree and the merchant dictionary, the same for everyone |

`backend/app/userdata.py` is the authoritative list. `data/` is gitignored and created as you use the app.

**Your original files** are always kept in `data/uploads/`; there's no setting to keep them anywhere else, so the
project folder holds everything about you. Keep the project out of folders that sync to the cloud: Plutus warns when
its folder syncs to iCloud Drive (including Desktop & Documents sync), Dropbox, Google Drive or OneDrive, since your
statements would then leave this Mac. An older Plutus could keep files in a folder of your choice; they're moved back
into `data/uploads/` at the next start. The startup log prints the folder in use and counts any files missing from it.

## Card designs

Each card on the dashboard is drawn in its bank's design (`web/src/components/cards/skins.tsx`), with the network's
mark once you set it; a bank without a design of its own gets a plain graphite card. The designs are the same for
everyone; which cards *you* have lives in `data/instruments.json`. Logos and designs belong to their banks and
networks and are drawn here only to show which card is which. See every design at `http://127.0.0.1:8000/#card-gallery`.

**A picture of your own card** goes in `data/card-art/`, named after the bank and the card as your statements name
them: `hdfc-bank--fake-rewards.jpg` for an HDFC Bank card named "Fake Rewards", or `hdfc-bank.jpg` for a card your
statements name only by its bank. JPG, PNG or WebP, about 700×400; reload the page to see it. A card your statements
name never gets another card's picture, nor its bank's. Like everything in `data/`, your pictures are never committed,
and no other website can load them from Plutus.

## Local AI (optional)

Plutus uses a local model through [Ollama](https://ollama.com) for two jobs, both fallbacks: placing payees that no
rule, dictionary entry or earlier answer covers (only their names and a typical amount are sent, to the model on this
Mac), and reading a payment screenshot whose layout the rules don't know. Without it, those payees go to "Needs your
eyes" and such a screenshot is reported as unreadable; statements, exports and everything else work the same.

To turn it on: install Ollama, then `ollama pull qwen3-vl:8b` (about 6 GB; it needs roughly 8 GB of free memory while
it runs). The header shows "Local AI · not set up" until then. Another model can be used with `ET_OLLAMA_MODEL`.

`backend/app/llm/ollama.py` manages Ollama for you:

- The first job that needs the model runs `ollama serve` on 127.0.0.1 (in about 0.3 s).
- Back-to-back jobs reuse the warm model.
- After 90 s idle (`ET_OLLAMA_IDLE_SECONDS`) the model is unloaded and the server is stopped.
- If Ollama was already running (the Ollama app in the menu bar runs its own server), it's left running: it isn't
  Plutus's to stop. Only the model is unloaded, which is what frees the memory.
- If the app was killed and left a server behind, it's stopped at the next start.

The header shows the model's state, not the server's: **asleep** whenever the model isn't in memory (even with the
Ollama app's server running), **working** during a job, **awake** for the minute and a half after it (hover for the
seconds left). Note that running an `ollama` command in a terminal (`ollama list`, `ollama ps`) opens the Ollama app if
no server is running, and the app then keeps one running until you quit it from the menu bar.

`make llm-check` does a live round trip: it starts Ollama, categorizes a few sample merchants, and stops it again.
The default `qwen3-vl:8b` is the *thinking* variant. The client works around its quirks, but the instruct variant
would be faster: `ollama pull qwen3-vl:8b-instruct`, then set `ET_OLLAMA_MODEL`.

## Tools

```bash
make inspect FILE="~/Downloads/statement.pdf"         # what the detector sees, content masked
make redact  FILE="~/Downloads/statement.pdf"         # layout-preserving anonymised copy → data/redacted/
make inspect-takeout FILE="~/Downloads/takeout.zip"   # a Google Pay export's structure, names and amounts masked
```

`inspect` and `inspect-takeout` print structure only, safe to share when something reads wrong; their temporary
copies go to `data/run/` and are deleted when they finish.
