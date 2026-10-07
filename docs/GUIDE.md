# Plutus guide

Everything about using Plutus: what it reads, how it counts, where your data lives. For what Plutus is and how it's
built, see the [README](../README.md).

- [Requirements](#requirements) · [Run it](#run-it) · [Your data stays yours](#your-data-stays-yours)
- [What happens to a file](#what-happens-to-a-file) · [What the terminal tells you](#what-the-terminal-tells-you)
- [How the numbers add up](#how-the-numbers-add-up) · [Credit cards](#credit-cards) ·
  [Credit card statements](#credit-card-statements) · [Google Pay](#google-pay-from-google-takeout)
- [Ask Plutus](#ask-plutus) · [Where things live](#where-things-live) · [Card designs](#card-designs) ·
  [Local AI](#local-ai-optional) · [Tools](#tools)

## Requirements

- **macOS**: screenshots and scanned PDFs are read with Apple's on-device OCR (Vision).
- **Python 3.12+**: macOS's own `python3` is older; `brew install python@3.13`.
- **Node 22.18+ and pnpm**, to build and test the UI: `brew install node pnpm`.
- **Optional: [Ollama](https://ollama.com)**, a local AI that sorts payees no rule recognises. Plutus suggests the model that suits your Mac and shows the steps (see [Local AI](#local-ai-optional)).
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
| `startup` | data folder, ledger size, the local AI: the model in use, or why there's none and what suits this Mac |
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
- for card bills that pay no statement you added, *card purchases* estimated from the bill (from your CRED history,
  or the payment a statement shows it received): the bill,
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
- **Card bills paid**: from CRED, and from your statements. Every statement lists the payment it received ("PAYMENT
  RECEIVED"); that row is a bill paid unless your CRED history has the same payment (same card, about the same
  amount, within five days), so with statements alone you still see your bills, and one paid through CRED is counted
  once. A statement's payment pays the cycle before it: covered when you've added that statement, else it stands for
  that cycle's card spending like any bill. Settles card spending, so it's never added to "Spent" (no double
  counting).
  Paying a bill in the CRED app with PhonePe shows up in both files: the bill in your CRED history and a UPI payment
  to "CRED" / "CRED Club" / "CredClub" / Dreamplug in PhonePe. The UPI side is always a card bill, never spending, and
  is linked to its bill (same minute, same amount, or up to 5% less when CRED rewards paid part of it), so the
  transactions list says which card it paid. The bill is counted once, in the Credit cards section.
  In the transactions list every card bill payment, either side of it, is marked **Bill paid**, its amount grey: it's
  neither money in nor spending (the tag is green on the card's side, where the payment comes in, like every row where
  money comes in: Refund, Cashback, Received, Transfer in). Filing one as something else (a payment through CRED that was really rent, say) asks
  first, the row on its own or among ticked payments ("Leave it out" changes the rest), because it would then count;
  moving it to Ignored doesn't ask. The ticked payments' total leaves card bills out.
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

**Changing categories** in the transactions list:

- **One payment**: its category dropdown. You're then offered to change that payee's other payments too ("Change
  all"), which also holds for their future payments.
- **Several payments you pick**: tick them (Shift-click ticks a run; the box at the top ticks every payment shown),
  choose their category in the bar that appears, and **Change**. Made for one payee that stands for several kinds of
  bill (a payment company that collects your insurance, phone and electricity bills): each ticked payment takes the
  category on its own, nothing is assumed about the payee's other or future payments, and **Undo** puts them back
  exactly as they were. Only payments shown can be ticked, so a change never reaches one you can't see.

Whatever you set for a payment is kept with its row (`data/row_answers.json`): the statement read again by a newer
reader, or deleted and added again, keeps your answers.

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

Add any bank's statement PDF: a month, a year's download holding several months, or the card's transactions over any
span (password-protected ones ask for the password once; it's never saved). There's no reader per bank. Plutus reads
every file two ways and lets the statement's own arithmetic decide:

- **by its table**: the transactions header found by meaning ("Date", "Transaction details", "Particulars",
  "Amount"…), the columns taken from where the header sits;
- **by its shape**: whatever the wording, a transaction is a date and an amount on one line, lined up in columns with
  the others. Dates are found however they're printed (12/08/2026, 12-Aug-26, Aug 12, 2026, "12/08/2026|14:05" glued to
  a time), amounts whatever form ₹ takes in the PDF's font (₹, Rs., INR, `, a "C"), and credits however they're
  marked (Cr, CR, C, +, −, brackets, a credits column or section, a Dr/Cr column even with another after it). The
  amount column is where the rows' figures line
  up, table by table (a first page laid out around its summary can print it a little to one side); a figure inside a
  description ("USD 12.99"), reward points, reference numbers and a column of letters after the amount aren't it. A
  wrapped row's amount on its second line is found too.

A word in a small box beside a row is a tag, not part of what the row says: HDFC puts "EMI" on a purchase you could
turn into EMIs (₹2,500 or more), and the purchase is an ordinary one, under the shop's own name.

What isn't transactions is left out: EMI schedules, rewards summaries, and the terms with their worked examples. Only
a heading starts the terms ("Terms and Conditions", "Illustration of how interest is charged"); a note that names them
in passing hides nothing, and a table of transactions after them is read.

Each reading is tried under every meaning a statement could give its marks (does "+" mark a credit or a debit? is a
lone "C" the rupee sign or a credit?). Then the check: **previous balance − credits + debits must equal the total due,
to the paisa** (a total printed in whole rupees, which the bank rounded, within 50 paise). A file that prints no
balances but its totals (a bank's statement of a whole year: "Purchases & Debits", "Payments & Credits") is checked
against those: the debits read must come to its total of debits and the credits to its total of credits, each to the
paisa. A file with a running balance proves its rows line by line instead: each balance moves from the one before by
exactly that row's amount. Summary labels are read however they're laid out: beside their figures, above them, or
wrapped over two or three lines ("Purchases &" over "Debits"). A
year's download is split into its statements (where each one's summary starts, with its statement date, or its due
date when it prints none), each checked against its own figures.

**A bank's statement of a year** (HDFC's "Year End Statement & Summary", say) sums up the monthly statements dated in
its year and then lists every transaction. Its totals cover those statements' billing cycles (MAY-2025 to MAR-2026,
each dated the 1st: 2 April 2025 to 1 March 2026), while its list can run on to the year's end. So it's checked over
those cycles: the rows inside them must come to its totals, debits and credits, to the paisa, and are then counted.
The rows past the last statement are shown as a part of their own, on hold, because nothing on the file adds them up.
Adding that month's statement proves them; or check them and count them.

A card's transactions downloaded from a bank's site as a PDF ("Credit Card Transactions") is read too, even with no
statement words on it: a card, and a table of dated amounts, are enough to recognise it.

Every statement ends up in one of these states, shown in Your vault:

| State | What it means | Counted |
|---|---|---|
| **Adds up** (proven) | exactly one reading accounts for the bank's figures | yes |
| **Read from its cells** (exact) | a CSV or Excel export: the bank's own data, no layout to guess | yes |
| **Two readings agree** | nothing on it to check against, but the rules and the local AI found exactly the same rows | yes |
| **Confirmed by you** | you checked a statement on hold and said its rows are right | yes |
| **On hold** | none of the above: no reading adds up, two different readings both do, or there's nothing to check against | **no** |

**A statement on hold counts nothing**: not its purchases, and it covers no bill (the bill's estimate stays). Your vault
opens it for you with why it's held, the arithmetic, and its rows as read. The page icon beside a row shows the page of
the PDF with that row marked, drawn on this Mac. Fix a row, add one that was missed or remove one that isn't a
transaction, and it's checked against the bank's figures again as soon as you save; when the rows are right, one click
counts them. A statement you confirmed or corrected keeps your version when it's read again later, unless the new
reading proves itself.

**The local AI, when the rules can't decide.** If Ollama is installed, a statement the rules couldn't prove (or couldn't
read at all) goes to the local model, about 20 lines at a time, every amount tagged with an id. It answers with
lines and ids, never with figures, so it can't invent or mistype a number. Its reading counts only if the statement's
own arithmetic proves it, or, for a file with nothing to check against, if it found exactly the rows the rules did.
Anything else stays on hold. Its answers are kept in `data/statement_ai.json`, so reading a file again doesn't ask
again. A long file with nothing to check against (a year's list of rows) isn't sent: the model could only agree row
for row, at about 20 seconds per 20 lines, so it waits on hold for you instead of holding up other files. Without
Ollama, nothing changes: statements the rules can't prove wait for you.

How sure can you be? The tests read random statements made up on every run: a new layout from each seed, monthly,
yearly or any span, varying everything banks vary (date formats and separators, column orders, reward points and
reference columns, forms of ₹, credit marks, wrapped rows, headers present or missing, EMI schedules and the terms'
worked examples beside the transactions, notes that mention the terms, a summary printed as a sum with only a due date,
a total rounded to the rupee, a first page's table printed to one side, a year's summary with only its totals, labels
wrapped over two lines, a card number after the Dr/Cr column). Every one with totals or a running balance must be proven exactly, every
one without must be held with exactly the right rows waiting for you, and none may be counted wrong.

What each row becomes:

| Row | Becomes |
|---|---|
| a merchant (debit) | a purchase on that card: the name cleaned ("PYU*SHOP BANGALORE" → SHOP), sorted by your answers, known merchants, then the bank's own category column as a hint ("RESTAURANTS"), then keywords and the local AI. A card purchase is never filed as a person |
| PAYMENT RECEIVED / BBPS / AUTOPAY, any credit saying PAYMENT, or one that pays the previous balance | your bill payment: Credit card bills, never spending or money in. The transactions list shows it as **Bill paid**, its amount grey with no +. Nothing learned about a name moves it ("Change all", the review list): the wording is the bank's, not a shop's. Filing that one row as something else asks first, since it would start counting |
| a merchant (credit), REFUND, REVERSAL | a refund, taken off the purchase it refunds (by the shop's name, or else the same card's purchase of exactly that much) |
| CASHBACK, REWARD | cashback (money in) |
| forex markup, GST, late, annual or joining fee, interest | Fees & Charges (counted as spending) |
| an EMI instalment (SHOP EMI 3/12, SMARTEMI …) | spending, in the bill that charges it: what you pay for the purchase, month by month (a converted purchase's EMI is principal and interest, plus GST on the interest). EMI interest is a fee |
| an EMI conversion (the purchase credited back as its EMIs begin) | taken off that purchase (same card, same amount), so it's counted once, by its instalments; without that purchase here, left out |
| a loan's instalment (Insta / Jumbo loan, loan on card) | Ignored: the loan went to your bank account, not to a shop |
| cash withdrawal | Cash |

A purchase paid over UPI with the card ("UPI-SHOP-shop@okbank") is a UPI payment, counted in UPI spends. A RuPay card
used on UPI shows up in both your UPI statement and the card's statement; the two are matched (same card, amount, and
a day either way) and kept as one payment, whichever file comes first. A Google purchase charged to the card is
matched the same way. Adding a statement again, or a better reader re-reading it, adds nothing twice (your answers
stay), and a row an earlier reading made up is dropped. A statement a reader couldn't read is tried again,
automatically, when the reader improves. Deleting it removes its rows and its record, and the bill it covered counts
again. If a statement reads wrong, `make inspect FILE=...` shows its layout and what the reader decided, with every
name and number masked, safe to share.

### Exports of a span

The card's transactions exported from the bank's app or site, over any span, work too: CSV, Excel (.xlsx, or the HTML
table some banks save as .xls) and PDFs. Columns are found by what their headers mean; credits by a Dr/Cr column or
mark, separate debit and credit columns, or a sign (the sign your payments carry is the credits'). A purchase that a
statement of yours also lists is counted once, even when the export dates it when it posted (up to three days later)
or names the shop its own way. A bill for a cycle an export lists whole adds no estimate; for a cycle it lists part
of, what it lists comes off the estimate. An export that doesn't print its card number is taken to be your only card
of that bank, and says so. A CSV or Excel export is read from its own cells ("Read from its cells", counted); one whose
rows don't add up to totals it prints, or whose credits are told apart only by a sign nothing in it explains (no
payment to show which sign is a credit), is held for you instead.

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

## Ask Plutus

Click the gold Plutus button in the dashboard's bottom-right corner (it stays there as you scroll) and ask about your
spending in your own words: "How much on electricity in 2025?", "Top 5 payees last year", "Compare FY 2024-25 and FY 2025-26", "Food delivery by month in 2026", "Biggest
payments last month", "When did I last pay rent?", "How much came in as cashback this year?". Then follow up: "and in
2024?", "only UPI".

**Every number is the dashboard's.** Plutus reads what you asked, then works the answer out from your files the way
the dashboard does: a year's total equals Total spend for that year, a category's equals its bar, a payee's equals
its line in *Who you paid most*. No AI adds anything up, and no AI is shown or trained on your payments.

**How a question is read.** Rules in the page read most questions instantly:

- periods: years, India's financial years ("FY 2024-25", or "FY25": April 2024 to March 2025), months, "last 3
  months", "since April", "this week";
- categories by name or a common word ("petrol", "groceries", "rent");
- payees by words of their names;
- a card by its last four digits or its bank ("on my 1111 card");
- follow-ups.

When the rules aren't sure (a word they don't know) and the [local AI](#local-ai-optional) is set up, the question
goes to it, on this Mac. It gets only the question, today's date, the list of categories (the same for everyone) and,
for a follow-up, how the last question was read: never a payment, an amount or a name from your files. Without the
local AI, the rules answer what they understood and say what they weren't sure of, or offer questions to try.

**What an answer shows:**

- the figure and a sentence, with lines (payees, months, the biggest payments) when there's more than one number;
- *How I read it*: the category, payee, card and period it used, as chips. Remove one or pick another period and the
  answer is worked out again;
- what it leaves out:
  - card spending known only from card bills (it has no category or payee, so a question about one can't include
    it, and the answer says how much);
  - a statement on hold;
  - investments, when they're left out;
  - and where your files start, when the period begins before them;
- *Show these payments*, which opens exactly the payments behind the answer in the transactions list.

**What it can do:** totals, counts, averages (per payment or per month), top payees and categories, the biggest
payments, two periods compared, month by month, lists, and the last payment. **What it can't:** give advice, explain
why, or change anything (re-file a payment, add a file). The chat stays while you close and reopen the panel; reloading
the page or *Clear the chat* empties it. Nothing about a question is saved, and the terminal never shows one.

## Where things live

| Path | What |
|---|---|
| `data/uploads/` | Your original files, sorted into `credit-card-statements/`, `cred/`, `upi/`, `screenshots/`… |
| `data/uploads.json` | One record per file: hash, what was detected, import result |
| `data/ledger/<year>.json` | Every transaction, flat, one file per calendar year |
| `data/card_payments.json` | Credit card bill payments (from CRED, or a statement's own payment row), and the billing cycle each paid for |
| `data/instruments.json` | Cards discovered from statements and CRED history |
| `data/card_networks.json` | The network you set for each card; survives deleting the files that found it |
| `data/card_statements.json` | Your card statements and exports: period, due date, the bank's totals, and whether the rows add up |
| `data/accounts.json` | Your own bank accounts, last four digits only, so transfers between them are left out |
| `data/payees.json` | Your payee table: people and accounts you pay, e.g. "Mr Fake Payee" → Water delivery, your landlord → Rent |
| `data/merchant_memory.json` | Your corrections and the local AI's earlier answers, per payee name |
| `data/row_answers.json` | The category you set for one payment, kept with its row: delete a file and add it again, and your answers come back |
| `data/settings.json` | Your settings: whether investments count as spending, the local model you picked, whether you've seen the local AI hint |
| `data/state.json` | Housekeeping: which rules your ledger was last sorted with |
| `data/run/` | Files being received, the tools' temporary copies, the local AI's process id and log |
| `data/redacted/` | Anonymised copies made by `make redact` |
| `data/card-art/` | Pictures of your cards you added, shown on their card faces ([below](#card-designs)) |
| `data/statement_ai.json` | The local AI's answers about statements the rules couldn't prove, so a file read again doesn't ask again |
| `backend/app/seed/` | Not yours: the category tree and the merchant dictionary, the same for everyone |

`backend/app/userdata.py` is the authoritative list. `data/` is gitignored and created as you use the app.

**Starting over.** *Remove all my data…* at the foot of Your vault moves everything in this table (`data/…`) to the
macOS Trash as one folder, "Plutus data (removed 6 Oct 2026, 14.03)", and Plutus is as a fresh clone has it, with no
restart. It lists what goes, with counts, and asks you to type `start over`. Nothing is erased: until you empty the
Trash you can put it back (quit Plutus, then move that folder's contents back into `data/`). It waits while files are
being read or the local AI is working, stops an Ollama that Plutus started, and moves only what the table lists:
anything else in the folder stays. Plutus itself, Ollama and its models, and the demo (`.demo/`) stay too.

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

Plutus uses a local model through [Ollama](https://ollama.com) for four jobs, all fallbacks: placing payees that no
rule, dictionary entry or earlier answer covers (only their names and a typical amount are sent, to the model on this
Mac); reading a payment screenshot whose layout the rules don't know; reading a card statement the rules couldn't
prove, where its answer counts only if the statement's own figures prove it ([above](#credit-card-statements)); and
reading a question to [Ask Plutus](#ask-plutus) the rules couldn't (only the question is sent). Without it, those payees
go to "Needs your eyes", such a screenshot is reported as unreadable, such a statement waits on hold for you, and Ask
Plutus answers what its rules understand; everything else works the same.

**Setting it up.** Click **Local AI** in the header (or *Check this Mac* on the welcome page). Plutus reads this Mac (its
chip, memory, free space and macOS version) and Ollama (whether it's installed, its version and the models it has
downloaded), suggests the model that suits it, and shows only the steps still needed, each command with a copy
button. **Plutus never downloads a model or installs Ollama**: you run the steps, and it notices the model by itself,
with no restart. `make check` prints the same advice in Terminal.

| This Mac's memory | Plutus suggests | Download |
|---|---|---|
| 8–15 GB | `qwen3.5:2b`, a little less accurate | 2.7 GB |
| 16–23 GB | `qwen3.5:4b`, the best balance of speed and accuracy | 3.3 GB |
| 24 GB or more | `qwen3.5:9b`, the most accurate | 6.6 GB |
| under 8 GB, or an Intel Mac | none: a local model would only slow it down | |

The steps, for a Mac with nothing yet: install Ollama from [ollama.com/download](https://ollama.com/download) (it
needs macOS 14 or later), or `brew install --cask ollama-app`; then `ollama pull qwen3.5:4b` (or the model suggested
for your Mac). Ollama must be **0.32.7 or newer**: older versions let these models answer in prose instead of the
JSON Plutus asks for. The panel says when an update is needed.

**Which model Plutus uses**: `ET_OLLAMA_MODEL` if it's set; else the model you picked in the panel (*Use this*),
while it's downloaded; else the most capable downloaded model that suits this Mac (`qwen3-vl` models work too:
`qwen3-vl:8b-instruct`, `qwen3-vl:8b`, `qwen3-vl:4b-instruct`, `qwen3-vl:2b-instruct`); else none, and the header
shows "Local AI · not set up". A model Plutus doesn't know is listed as "not tested with Plutus" and used only if you
pick it. The lists are in `backend/app/llm/advice.py`, which needs only Python's standard library (so `make check`
can run it before setup). The panel reads Ollama's folders and asks its running server; it never starts Ollama.

**A one-time hint.** When an import leaves payees in "Needs your eyes" or a statement on hold and there's no local AI
to handle them, a note under the Local AI pill says so once, with *See how* and *Not now*. Answering it either way
puts it away for good (`data/settings.json`).

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

`make llm-check` does a live round trip with the model Plutus uses: it starts Ollama, categorizes a few sample
merchants, and stops it again. `qwen3-vl:8b` is the *thinking* variant: the client works around its quirks (its
answer arrives as its "thinking"), but it's heavier and slower than the suggested models.

## Tools

```bash
make inspect FILE="~/Downloads/statement.pdf"         # what the detector sees, content masked
make redact  FILE="~/Downloads/statement.pdf"         # layout-preserving anonymised copy → data/redacted/
make inspect-takeout FILE="~/Downloads/takeout.zip"   # a Google Pay export's structure, names and amounts masked
make measure                                          # the statement readers on 1000 random made-up statements
```

`inspect` and `inspect-takeout` print structure only, safe to share when something reads wrong; their temporary
copies go to `data/run/` and are deleted when they finish.
