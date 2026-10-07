# Decisions

Why Plutus is built the way it is. Each entry says what was decided, the reason, what it costs, and where it lives.
Before undoing one, read it; if you change it, change it here too (a new entry that says what replaced what, and why).
The four core values these protect are at the top of [AGENTS.md](../AGENTS.md).

## 1. Local only, end to end

**Decision**: the server listens on `127.0.0.1`; the page loads nothing from the internet; the only other process
Plutus talks to is a local Ollama. No cloud OCR, no categorization service, no analytics.
**Why**: core values 1 and 4. People's spending is the most personal data they have.
**Costs**: OCR is Apple's on-device Vision (so macOS only); the AI is whatever runs on the Mac.
**Where**: `app/main.py` (hosts, same-machine writes, CSP), `app/config.py` (loopback-only AI host), the AI client
ignoring proxies, `backend/tests/conftest.py` (non-loopback sockets blocked in every test).

## 2. Everything about you in `data/`, through one list

**Decision**: every file about a user is in the data folder, listed in `app/userdata.py`, which is the only way in.
Originals always go to `data/uploads/`; there's no setting to keep them elsewhere.
**Why**: core values 2 and 3. A fresh clone starts empty; one folder holds everything to back up or remove.
**Costs**: a new kind of file means a new line in `userdata.py` (deliberately).
**Where**: `app/userdata.py`, `tests/test_own_accounts.py` (fails if code goes around it).

## 3. JSON files, no database

**Decision**: plain JSON files, written atomically, one lock per file.
**Why**: the owner's choice: nothing to install or run, files a person can read, a folder that is the whole state.
**Costs**: a file is rewritten whole on change; fine at one person's scale (years of payments).
**Where**: `app/jsonstore.py`, `app/ledger.py` (one file per calendar year).

## 4. No parser per bank: read by shape, decide by arithmetic

**Decision**: card statements are read by their table header and by their shape (dates and amounts in any form,
columns where figures line up), under every meaning their marks could have; the statement's own arithmetic picks the
reading.
**Why**: any bank, any layout, any period, without asking users to send statements or writing code per failure. A
parser per bank breaks silently when the bank changes its layout; arithmetic doesn't lie.
**Costs**: a more complex reader; it's held to account by `make measure` (1000 random statements, none wrong) and fakes
of real banks' layouts (`tests/fake_cards.py`).
**Where**: `app/parsers/card_statement.py`, `shape_reader.py`, `statement_reader.py`; [READERS.md](READERS.md).

## 5. Unproven means on hold, never counted

**Decision**: a statement whose rows the bank's own figures don't account for exactly is held: shown in Your vault,
counted nowhere, until the user confirms or corrects it.
**Why**: "the data should be accurate, no mistake". A wrong number counted is worse than a number waiting.
**Costs**: sometimes the user has to look at a statement.
**Where**: `statement_reader.decide`, `CardStatement.held`, `PUT/POST /api/card-statements/{id}/held|confirm`.

## 6. The local AI points; it never writes a number

**Decision**: for a held statement, the AI sees lines with every amount tagged and answers with tags; its reading
counts only if the statement's arithmetic proves it. A screenshot's amount read by the vision model must appear in the
OCR text. Summary figures are never taken for rows.
**Why**: a model can invent; the figures must always be ones the file prints.
**Costs**: the AI is a helper, not a reader: a statement it can't prove stays held.
**Where**: `app/parsers/statement_ai.py`, `app/parsers/screenshot.py`.

## 7. The AI is optional, and Plutus never downloads or installs anything

**Decision**: everything works without Ollama. Plutus suggests the model that suits the Mac and shows the steps (install
Ollama, `ollama pull …`); the user runs them. It uses the user's pick, else the best model already downloaded.
**Why**: core value 4, and the user decides what lands on their machine. A multi-GB download is never the app's call.
**Costs**: a few steps for the user to run.
**How it suggests**: by total memory (8–15 GB `qwen3.5:2b`, 16–23 GB `qwen3.5:4b`, 24 GB+ `qwen3.5:9b`; none on Intel
or under 8 GB), Qwen 3.5 being the newest small family that also reads images. The levels are judgment from published
sizes, not yet measured on Plutus's own tasks ([ROADMAP.md](ROADMAP.md)). Ollama 0.32.7+ is required: older versions
let these models answer in prose when thinking is off.
**Where**: `app/llm/advice.py`, `app/llm/setup.py`, `components/AiPanel.tsx`.

## 8. Ollama runs only while needed

**Decision**: the first job starts `ollama serve` on `127.0.0.1`; after 90 s idle the model is unloaded and a server
Plutus started is stopped. A user's own Ollama is left running. The page shows the model's state, not the server's.
**Why**: a model holds gigabytes of memory; it shouldn't while nothing needs it.
**Where**: `app/llm/ollama.py`, the AI pill in `components/Header.tsx`.

## 9. Never count the same money twice

**Decision**: a card bill pays for a cycle of purchases. A cycle a statement (or an export spanning it) lists is
counted purchase by purchase, and its bill adds nothing; a cycle nothing lists is estimated from its bill, less what's
already counted, spread over the cycle. The UPI section plus the card section always equals Total spend.
**Why**: a bill, its purchases, and the card used on UPI are three views of the same money.
**Where**: `app/billing.py`, `web/src/lib/totals.ts`, `web/src/lib/cards.ts`, and their tests.

## 10. Card bill payments are neither spending nor money in

**Decision**: paying your card, on either side (the statement's "PAYMENT RECEIVED", the UPI or bank payment), is a
card bill. A statement's bill payment is never moved by a name-based answer ("Change all", the review list, a
correction by payee), because its wording is the bank's, not a shop's; changing one row asks first. The list shows it
neutral: a "Bill paid" tag, a grey amount with no "+".
**Why**: counting it as income or spending would double count the purchases it pays for; a slip of a menu shouldn't be
able to.
**Where**: `categorize.statement_bill`, `routes/ledger.py` (`_changeable`, `_same_shop`),
`components/dash/TransactionsTable.tsx`.

## 11. EMIs: the cash view

**Decision**: an EMI instalment is spending in the bill that charges it; a purchase converted to EMIs is credited back
and nets against that purchase (same card, same amount), so it's counted once, by its instalments; a loan's
instalments count nowhere (the loan went to a bank account). An "EMI" badge on a row can mean *eligible*, not paid.
**Why**: what you pay, month by month, is what the dashboard should show.
**Where**: `card_statement.classify`, `categorize.link_refunds`.

## 12. Your answers are kept twice: by name and by row

**Decision**: an answer for a payee is kept by name (it applies to their future payments); an answer for one payment
is kept with its row (`data/row_answers.json`), so a re-read, an import running meanwhile, or the file deleted and
added again never loses it. Ticking several payments sets each as if alone and teaches the payee nothing (one payment
company can stand for insurance, phone and electricity).
**Why**: answering twice is the fastest way to lose a person's trust.
**Where**: `app/categorize.py` (`row_key`, `remember_rows`), `ledger.update_transactions`, `routes/ledger.py`.

## 13. Calendar years, and investments a choice

**Decision**: the dashboard's timeline is calendar years. Investments can be left out of spending (a choice kept in
`data/settings.json`); left out, they still come off card bills.
**Why**: how the owner thinks about a year; some people track investments elsewhere.
**Where**: `web/src/lib/periods.ts`, `web/src/lib/scope.ts`, `app/preferences.py`.

## 14. Start over moves to the Trash; it never erases

**Decision**: "Remove all my data…" moves everything `userdata.py` lists (and nothing else in the folder) to the macOS
Trash as one folder; it asks for typed confirmation, refuses while a file is being read or the AI is working, refuses
a folder that isn't Plutus's own, and puts everything back if the Trash refuses.
**Why**: a complete reset should be easy to find and impossible to regret by accident.
**Where**: `app/reset.py`, `components/StartOver.tsx`.

## 15. Fake data only, everywhere in the repo

**Decision**: tests, fixtures, docs and screenshots use made-up data: generated statements, fakes of banks' layouts,
a made-up demo year. No value from a real statement, not even one amount.
**Why**: core value 2, and the repo is public.
**Where**: `tests/statement_gen.py`, `tests/fake_cards.py`, `app/tools/demo.py`; the pre-commit hook.

## 16. Design: calm, honest, consistent

**Decision**: a neutral dark UI (zinc greys, glass panels); green only for money coming in, amber to look at, rose for
danger. Charts use a validated palette, thin marks, one filter row and a table view each; a category's or card's colour
is fixed from all-time totals, never by rank in a period. Every state is worded: empty, busy, error, done.
**Why**: a finance tool earns trust by being clear and calm; colours that move between periods mislead.
**Where**: `web/src/index.css`, `web/src/lib/totals.ts` (`colourSlots`), `web/src/lib/cards.ts`.

## 17. One instruction file for every agent

**Decision**: [AGENTS.md](../AGENTS.md) is the single entry point for AI agents and people; `CLAUDE.md` and
`GEMINI.md` import it. [ARCHITECTURE.md](ARCHITECTURE.md) is the map, checked by `tests/test_docs.py`.
**Why**: whoever picks Plutus up next, with whichever agent, should start from where the project is, not from zero.

## 18. Ask Plutus: the AI reads the question, Plutus computes the answer

**Decision**: a question is read into a query of a fixed shape (what kind of answer, categories, payees, cards,
channel, period) by rules in the page, and by the local AI only when the rules are unsure; the page then works out the
answer from the ledger with the dashboard's own counting. The model is never trained on, fine-tuned with or shown a
transaction: it sees the question, today's date and the category tree. Nothing about a question is stored or logged;
the chat lives in the page until it's closed or reloaded.
**Why**: a model that reads the ledger and writes the answer can add wrongly, invent a payment, or contradict the
dashboard, and a small local model would do so often; one that only reads the question can't get a number wrong. The
rules answer most questions instantly and keep the chat working without Ollama (core value 4: the AI is optional).
**Costs**: only questions the query shape can express ("why", advice and actions aren't); a question the rules can't
read waits a few seconds for the AI, or, without it, gets a partial answer marked unsure, or questions to try.
**Where**: `web/src/lib/askRules.ts`, `web/src/lib/ask.ts`, `app/ask.py` (`POST /api/ask`, the answer checked
against the schema and the category tree), `components/AskPanel.tsx`; parity with the dashboard in
`web/tests/ask.test.ts`.

## 19. A bill is a bill, whichever file it was read from

**Decision**: a statement's (or bank export's) own row for the payment it received is a card bill paid, placed by the
same rules as a bill from CRED: covered when you added the statement it pays, else it stands for that cycle's card
spending, estimated. It's skipped when an app's bill is the same payment (same card, within 5% of the amount, within
five days: the bank posts a day or a few after the app records it), each app bill standing for one row. Statement bills
aren't stored as facts of their own but made again whenever bills are placed (`origin: "statement"`), so a row
re-filed as something else, or a file deleted, takes its bill with it; and the bills are placed again after every edit
of the ledger (`@ledger.exclusive`), not only after imports.
**Why**: someone who adds only statements paid their bills too; the statement prints the payment, so the bills paid,
the Credit cards section and Ask Plutus showed none for no reason, and the cycle before their first statement, which
that payment pays for, was missing from Total spend. Treating the two sources differently would make the same
payment count differently by where you read it.
**Costs**: a payment that isn't a whole bill (a part payment, an advance) is placed like any bill, as a CRED one is;
an app's bill paid more than five days from the bank's posting, for a different amount, would be counted as two.
**Where**: `app/billing.py` (`statement_bills`), `app/ledger.py` (`_place`, `exclusive`), `app/models.py`
(`CardPayment.origin`); tests in `tests/test_billing.py` and `tests/test_import_pipeline.py`.

## 20. One payment, one row

**Decision**: every side of a card bill payment points to the bill it is (`Transaction.settles`): the UPI or bank
payment that paid it (to CRED's record by the same minute and amount; straight to the card's biller, to the payment
the statement shows, the same amount posted within five days after, and only when nothing else could be it either
way), and the statement's own "PAYMENT RECEIVED" (to the app's bill it matched, or to its own). The links are made
whenever bills are placed. The transactions list shows each payment once, on the side you paid from, marked
"+ Statement"; a change of its category changes every side.
**Why**: paying a card bill is one movement of money seen from your account and from the card. Shown twice it looked
like two payments and invited filing them differently; the totals were right, the list wasn't.
**Costs**: a payment to a biller is linked only when unambiguous, so two equal payments in the same days stay as two
rows; a payment and its posting in different years show in each year's list on their own (with where the other is).
**Where**: `app/categorize.py` (`link_card_bills`), `app/billing.py` (`statement_bills`), `app/ledger.py` (`_place`);
`web/src/lib/ledger.ts` (`billSides`, `oneRowPerPayment`, `billNote`, `cardSide`),
`components/dash/TransactionsTable.tsx`.

## 21. How a payment was made: chips from what the files say

**Decision**: each row of the transactions list says how the payment was made in the "Paid with" column (right after
the payee, before the category: Date, Payee, Paid with, Category, Amount, as the owner set it): a chip each on top,
the account or card on the line below. **Card** (the card's number), **PhonePe**, **GPay** or **Paytm** (UPI in that
app), **UPI** (the app isn't known); a card through an app is both chips (**Card** **PhonePe**, a RuPay credit card
on UPI; **Card** **GPay**; **Card** **UPI** when only the card's statement shows it). A card is known the way the
"Paid from" label knows it; the app is the one whose history the payment came from. The chips' tooltip says it in
words. They have a row tag's shape, tinted by kind as the owner chose: a card in the charts' blue
(`--color-series-1`), UPI and its apps in their violet (`--color-series-7`), the text mixed lighter (9:1 and 8:1
contrast); never green (money in), amber or rose.
**Why**: the owner asked for card, card-on-UPI and each app to be told apart. Kept in its own column, the chips line
up for scanning and sit with the account they describe; the payee column keeps only status tags (Bill paid, Refund,
+ Statement). Two tints tell a card from UPI at a glance; no brand colours or logos (every UPI app shares one violet),
and the app names only identify where a payment was read. Tap, swipe and online aren't told apart because statements
don't reliably say which, and Plutus doesn't guess.
**Where**: `web/src/lib/ledger.ts` (`howPaid`), `components/dash/TransactionsTable.tsx` (`paidWith`), the
`chip-card` and `chip-upi` styles in `web/src/index.css`; tests in `web/tests/ledger.test.ts`.
