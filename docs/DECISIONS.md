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
**And nothing of yours outlives it anywhere else** (the owner: "no cache nothing else retained… a blank slate
completely"):
- **The browser's cache:** every `/api` answer is sent `Cache-Control: no-store` (one rule, in `app/main.py`'s
  middleware), so a browser never writes your payments, payees, cards, a card's picture or a file to its disk cache.
- **The page:** the moment the server confirms, it forgets what it kept in the browser (`plutus.*`: how its panels
  were left, ticked chart lines among them, which include your cards' ids), not only when you press "Start fresh",
  so closing the tab can't leave it behind.
- **Other open tabs:** any other open tab of Plutus is told and loads again, empty (`lib/startOver.ts`, through the
  browser's BroadcastChannel). The tab that started over ignores its own news and keeps its dialog.
- **The server's memory:** it forgets the local model you chose then and there, and picks one as a fresh Plutus does.
- **The Trash stays the place it all goes**, recoverable until emptied; the owner chose that over erasing.
**Where**: `app/reset.py`, `components/StartOver.tsx`, `lib/startOver.ts`, `App.tsx` (the other tabs), the
middleware in `app/main.py`; `tests/test_start_over.py`, `web/tests/startOver.test.ts`, and the walkthrough
(`scripts/checks/walkthrough.mjs`, with a second tab).

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

## 22. India's seasons are IMD's months, with December in winter

**Decision**: Ask Plutus reads "last winter", "this monsoon", "summer 2025" as India's seasons, by the months of the
India Meteorological Department with December in winter, as the owner chose: winter December to February, summer
March to May, monsoon June to September, post-monsoon October and November. The whole year is covered, with no
overlaps. "Last" is the latest season that has ended; "this", "the" or "during" the latest that has begun; a season
with its year is that one ("winter 2024-25"), but "winter 2025" could be either winter and is left unsure. A season
word counts only with a word that makes it a time or with its year, so a name like "Summer House" stays a name.
**Why**: the sources don't agree on winter: IMD's data seasons give winter as January and February
([IMD](https://metnet.imd.gov.in/docs/imdnews/imdnewsvol151_E.pdf)), the Government of India's Know India page
December to early April ([Know India](https://knowindia.india.gov.in/profile/climate.php)); both give the monsoon as
June to September, which the local AI had been told was July to September. December in winter is how most people
mean it.
**Where**: `SEASONS` and `seasonPeriod` in `web/src/lib/ask.ts`, read in `lib/askRules.ts`; `SEASONS` in
`backend/app/ask.py` builds the prompt's sentence, and `tests/test_ask.py` fails if the two tables differ.

## 23. Why a period differed: the difference, split exactly, against the period before

**Decision**: a "why" question (`kind: "why"`) is answered with the difference between two periods, split into what
made it: by top-level category, or by payee when the question names one category or a payee; card spending known
only from bills as a line of its own; the biggest changes first, the rest as "Everything else", so the lines add up to
the difference. Both periods are counted as the dashboard counts them. With one period named, it's set against the
period before, as the owner chose (`periodBefore`): the month before a month, the year before a year, the financial
year before one, the same season a year earlier, the same whole months or days just before any other span. The answer
says which way it really went, whatever the question assumed, and the "against" chip changes the comparison.
**Why**: a why that the model writes can be wrong; one worked out from the ledger can't, and it can be checked against
the totals. "The period before" matches "went up", and an average month would have no payments to show.
**Costs**: it says what changed, not the cause behind a payment (a new rent, a trip); that's for the reader.
**Where**: `whyAnswer` and `periodBefore` in `web/src/lib/ask.ts`, read in `lib/askRules.ts` and by the local AI
(`app/ask.py`); the chips in `components/AskPanel.tsx`; tests in `web/tests/ask.test.ts` and `askRules.test.ts`.

## 24. A phone gets the whole page: nothing sideways, a short bar, the orb aside while scrolling

**Decision**: nothing on the dashboard scrolls sideways. Content with a wide form has a narrow one, chosen by the
width of its own box (`useFits`), not the screen's: the transactions list is a table where its 760px fit and a list
otherwise (payee and amount, then how it was paid, then the day and the category, the year left off when every
payment shown is in one year); a held statement's rows likewise from 560px. Both forms are built from the same parts,
so they can't drift apart. The bar that stays at the top holds only what scopes the page, the years and the
investments switch, on one row even on a phone ("Investments" there, "Count investments" by name); the years scroll
sideways if they must, faded where there are more, the chosen one kept in view. What the files cover scrolls with the
page. The Ask Plutus orb stays where it is, but where it would cover the page's column it shrinks into the corner
while you scroll down, and is back as soon as you scroll up or stop.
**Why**: on a phone the table showed the date and payee and hid the amount, category and how it was paid behind a
sideways scroll with no sign of it; the pinned bar took 197 of 844 pixels on every screen. Nielsen Norman Group
advise keeping a sticky header as small as its content allows, and signalling any sideways scrolling, which works
poorly on phones ([sticky headers](https://www.nngroup.com/articles/sticky-headers/),
[mobile tables](https://www.nngroup.com/articles/mobile-tables/)). Going by the box, not the screen, also fixes a
tablet, where the table didn't fit either.
**Costs**: on a phone a payment takes three lines instead of one; at rest, the orb still sits over the bottom-right
corner of the screen, as it always has.
**Where**: `web/src/lib/useFits.ts`; the list in `components/dash/TransactionsTable.tsx`, the held rows in
`components/Vault.tsx` (`HeldReview`); `YearTabs` and `Coverage` in `pages/Dashboard.tsx`; `useStepAside` in
`components/AskOrb.tsx`; `dayMonthLabel` in `lib/periods.ts`, tested in `web/tests/periods.test.ts`.

## 25. Every text readable, every control reachable, Increase contrast honoured

**Decision**: every grey a word is set in reaches WCAG's 4.5:1 against every surface it sits on. Labels and values
keep zinc-100 to zinc-400 (7:1 and up); helper text, which was zinc-500 (3.3 to 4.1:1), is `--color-muted`
(#888893, 4.6:1 on the most raised surface, 5.5:1 on a card); zinc-600 and 700 (as low as 1.85:1) went to muted
wherever they carried words (the "as printed" notes, times, the sum's + and =, placeholders, the Google Pay steps)
and to `--color-faint` where they were decoration (bullets, separators, an icon beside its words, a chart's month
with no data). Every control is at least 24 by 24 (WCAG 2.2's target size); on a touch screen the header's buttons,
the years, the investments switch, the list's filters, search, each payment's tick and Show more take a 44px tap
(Apple's default) through an invisible margin (`tap`), so nothing looks bigger; the list's category pickers, which
can't take a margin, are 32px under a finger (above Apple's 28pt least). With the Mac's Increase contrast on,
helper text is 7:1, the faint grey takes muted's place, lines between rows are 25% white and the edges of cards,
tiles and controls 40% (3:1 against a card), all in one block of `index.css`.
**Why**: about 300 pieces of text on the dashboard fell short of 4.5:1, and 95 controls on a phone were under 24px,
some at 14 ([WCAG 2.2 contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [target
size](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22), [Apple's control
sizes](https://developer.apple.com/design/human-interface-guidelines/accessibility)). Named greys, checked by a test
from the CSS itself, keep it that way: the test fails if text uses zinc-500 to 700, or a faint edge is missing from
the Increase contrast block.
**Costs**: labels and values keep Tailwind's zinc-100 to 400 (they pass); only the two roles that failed got names.
A dropdown's touch target is its own size. In Increase contrast, a hover no longer brightens a faint edge (it's
already bright).
**Where**: `--color-muted`, `--color-faint`, `--color-card`, the `tap` utility and the `prefers-contrast: more` block
in `web/src/index.css`; `web/tests/contrast.test.ts`.

## 26. The month-by-month table: a row a category, a column a month

**Decision**: the table under **Show table** (Month by month in Total spend, and in Credit cards) has a row for each
ticked line, a category or a card, in the chips' order with its colour beside its name, and a column for each month,
Jan to Dec, then **Total**: the line's own figure for the period, the same as its chip (a category's months add up to
it, and a test holds that for every year, investments counted or not). **Together** under the rows adds up each
month. Across several years (All years) the columns are the years, each the sum of its months, so the table stays a
dozen columns wide. "—" is a month no file covers, "≈" an estimate from a bill, and ₹0 is in the quieter grey so the
amounts stand out. From 1024 to 1279px wide the table is a size smaller and closer, so a whole year fits a laptop;
on a phone, or where the figures are too wide, the names stay put while the months scroll, the far edge faded, and
what slides under the names fades into them.
**Why**: the owner found the table, a row a month and a column a category, hard to read: with many categories ticked
it scrolled sideways, and All years made it a hundred rows long. Months across the top is how a year of figures is
read (left to right), and a category's row reads like its line in the chart. A total each row says what the months
come to. Years as columns keep All years to a handful of columns instead of a hundred.
**Costs**: a year fits without scrolling while each month is under ₹1 lakh (checked in a browser at 1024, 1200, 1280
and 1440px); bigger figures widen their column, and with every month of every row at ₹1 lakh or more it runs about
80px over (230 if every figure is also an estimate), where the pinned names and the fade take over. A phone always
scrolls: twelve figures don't fit 390px.
**Where**: `web/src/lib/trendTable.ts` (tested in `web/tests/trendTable.test.ts`), `TrendTable` in
`web/src/components/dash/Trends.tsx`, `web/src/lib/useEdgeFade.ts` (shared with the years); the months-add-up check in
`web/tests/totals.test.ts`.

## 27. The page grows with the window; a chart's names go under it

**Decision**: the page is as wide as about 80% of the window, leaving about 10% each side, never narrower than it was
(1104px of content, so a 1280px screen keeps its layout) and at most 1600px; one rule (`page` in `index.css`) sets it
for the header, the dashboard and the welcome page, so their edges line up. Phones and tablets are unchanged. In the
month-by-month charts the line names are a key under the chart (each ticked line's mark, dashed for an estimate, and
name, in the chips' order, wrapping), not a column beside the plot, so the plot runs the full width of its card; it
also grows taller with a wider page (280px, as before, until the window is about 1510px wide, then with the width, at
most 360). The UPI
month-by-month bars grow the same way (190 to 240). The transactions list's Payee column may take up to 28rem.
**Why**: on a 1728px screen the page was 1104px wide, leaving 17% empty each side, and the chart kept 136px beside its
plot for names that, with many lines ticked, stacked into a list that no longer sat by its lines. The owner asked for
about a 10% gap each side and the names below the chart. The cap keeps a row of the transactions list readable on a
very wide screen.
**Costs**: lines aren't named where they end; the key and the tooltip name them, and pointing at a name in the key
brings its line forward (the way to pick out one of the grey lines). Past 2000px the sides grow beyond 10%.
**Where**: `page` in `web/src/index.css`; `Key` and the plot's size in `web/src/components/dash/Trends.tsx`;
`web/src/components/dash/MonthlyChart.tsx`; the Payee column in `web/src/components/dash/TransactionsTable.tsx`.

## 28. The page's checks live in the project, and run on the demo only

**Decision**: the browser checks that came before a release (every figure that shows in more than one place, the
ledger through the API, the page's width, the month tables, phones, contrast and tap targets, and Plutus used start to
finish) are in `scripts/checks/`, run by `make check-ui`. It starts the demo's made-up year on 8001 with the AI off,
sends Start over to `.demo/trash` instead of the Mac's Trash, drives the Chromium-based browser already on the Mac
(Chrome, Brave, Edge or Chromium) through its debugging protocol, and stops; it exits 1 if anything fails. `run.mjs`
refuses any server whose data folder isn't `.demo/data`, and the walkthrough, which starts over, runs only when the
demo was started for it (`PLUTUS_CHECKS_MAY_START_OVER`). The checks compare the page with itself and with the API
(a figure in two places, the same; a total, its parts), so they hold for any made-up year, not only today's demo.
**Why**: they lived in a scratch folder, were lost once and had to be rebuilt. In the project they can be run before
every release, by anyone, and a change that breaks what they check is caught.
**Costs**: about five minutes; a browser of Chromium's family is needed (as for `make screenshots`). They aren't in
`make test` or CI, which have no such browser; the logic they check is in the unit tests there. The walkthrough waits
by the clock in a few places (an animation, a save), so a very slow Mac could fail one; run it again before
believing it.
**Where**: `scripts/checks/` (`run.mjs`, `browser.mjs`, one file per area), the `--checks` mode of
`app/tools/demo.py`, `make check-ui`.

## 29. Total spend says where a category's money went, one shop however it's spelt

**Decision**: under Total spend's sum (which stays), the sentences explaining it are gone; in their place is what you
tap. A category: its top six payees (its sub-categories together; a sub-category, its own), the rest in one line, and
its five biggest payments, with **Show all** opening its payments in Your transactions. Uncategorized: its payees, each
with a category picker (one answer files each spelling of that payee waiting there, in every year, the way the review
list answers). Card purchases: the cards and each card's bills, since a bill doesn't say what it paid for. Other: its
categories. With nothing tapped: the biggest payment, the top payee, the busiest month (Month by month's Together),
the year against the one before over the months both years' files cover alike (the same kinds of file), and one
action (the bigger of what waits in Uncategorized and what's only estimated from bills; adding a card when there's
none). Side by side (1280px and wider) the detail sits under the ring; stacked, it opens under the row you tapped. A
payee is one row per shop: the server sends each payment's shop with `/api/transactions` (`categorize.shops`: the
merchant list's name when it knows the shop, else the spelling its payments use most), worked out when served, never
stored. "Who you paid most", "Where you used your cards most" and Ask Plutus's top payees group the same way, and Ask
matches a payee's word against its shop as well as its printed name.
**Why**: the owner found the sentences under the sum were read by no one and asked to see where the money went: which
payees, across a category's sub-categories, and its biggest payments, using the space. One row per shop because a card
statement and a UPI app spell one shop differently ("BLINKIT GURGAON", "Blinkit"), which would split it in two. The
rule already existed (`same_shop`, used when one payment is re-filed); keeping it on the server keeps it one rule. A few
entries of the merchant list name a kind of payee, not one shop ("Electricity board", "Metro", "Gas"…: `"kind": true`):
they still file a payment, but two electricity boards are two payees, shown as their files spell them (before this,
re-filing one payment to one board offered the other board's payments as the same shop).
Years are compared only over months alike, so card statements one year has and the other doesn't can't show as a rise.
**Costs**: how card spending is estimated is explained where it applies (Card purchases' detail), not always on
screen, and "sent to people" and "invested" are no longer stated under the sum (the line under the years still says
what investments are left out). The same-shop rule takes numbers for store codes, so two local shops whose names
differ only by a number ("Fake Store 12", "Fake Store 14") are one row; the row says how many spellings it has. A
shop's name can change as payments arrive (its most used spelling). The demo has no category with more than six
payees, so "and N more" is held by `web/tests/focus.test.ts`, not seen in the browser checks.
**Where**: `web/src/lib/focus.ts` (tested in `web/tests/focus.test.ts`), `components/dash/SpendFocus.tsx`,
`TotalSpend.tsx`, `CategoryBars.tsx` (the detail under its row); `categorize.shops`, `ListedTransaction`
(`app/models.py`), `GET /api/transactions` (`backend/tests/test_shops.py`); `topPayees` in `lib/ledger.ts`, top payees
and payee words in `lib/ask.ts`; `scripts/checks/focus.mjs`.

## 30. Where you were, told to Ask Plutus; and Ask Plutus never gets more power than a dashboard button

**Decision**: you tell Plutus where you were, in Ask Plutus ("I was in Goa from 1 Jan to 5 Mar 2026", "forget Goa").
The rules read it (`readStay`, with day-level dates: "1st Jan", "1-5 Jan", "01/03/2026" day first, "since 3 Mar"; a day
without its year the latest begun, or the next for "will be"); the local AI only for days the rules can't place exactly,
and its place must be copied from the sentence. Either way it's a proposal: the reply shows the days, the payments on
them, what was spent and the days it takes from places told before, and only its button keeps it, through the route
the Places section uses (`POST /api/places`), with Undo. A typed "yes" changes nothing. A stay is kept in
`data/places.json`, apart from the ledger, which it never touches: each payment's place is worked out from its day (a
refund's, its payment's), the stay told latest winning a day two share. Places show in the Places section (between UPI
spends and Your transactions, once there's one: a card each, with Edit, Remove and Undo, and Add a place), in a
Location column after Payee in Your transactions (a Place filter, and the search), and in Ask Plutus's answers ("how
much in Goa?", "where was I in February?"). Card spending known only from bills has no days, so no place: an answer or
card about a place says about how much of it falls on those days. The rule for every action from the chat: **Ask
Plutus never gets more power than a button on the dashboard**: what it offers is what a button there does, through
the same route and checks, shown first, done by your click, undoable; anything that can't be undone (deleting files,
Start over) is never offered from the chat.
**Why**: the owner wanted spending tagged by place ("spent in Goa"). The files can't say where you were: a card
statement prints the merchant's registered town (the company's, for anything online), UPI histories print none, and
the location UPI apps send to NPCI isn't in any export. Telling Plutus is exact, private and simple, and the owner
chose Ask Plutus for it, with a Location column after Payee and a Places section. Keeping stays apart from the ledger
means a place can't change a figure, a statement for those days added later is placed too, re-reading a file can't
lose it, and removing it leaves everything as it was. Making the chat propose and the button act keeps Ask Plutus's
power no larger than the dashboard's, so a misread sentence costs a Cancel, never a change.
**Costs**: one place a day: a day trip and home on the same day can't be split. UPI and cash payments get a place
only from what you tell. Card spending known only from bills is never placed (only said about). The rules read
English and the formats above; other wordings need the local AI or the days said again.
**Where**: `app/places.py`, `app/routes/places.py` (`backend/tests/test_places.py`); `lib/places.ts`, `readStay` and
`dayRange` in `lib/askRules.ts`, `places` and the `where` kind in `lib/ask.ts` (`web/tests/places.test.ts`);
`components/AskPanel.tsx` (the told card), `components/dash/Places.tsx`, the Location column in
`components/dash/TransactionsTable.tsx`; stays and `where` in `app/ask.py` (`tests/test_ask.py`);
`scripts/checks/places.mjs` and the walkthrough; the demo's week in Goa (`app/tools/demo.py`).

## 31. A place's state, by number-plate code; the local AI reads a place from its words alone

**Decision**: a stay can carry its state ("Darjeeling, WB", "Bengaluru, KA"). States are written by the codes people
use, the number-plate codes of India's 28 states and 8 union territories (Telangana's TG since March 2024, the merged
DD since January 2020). They sit in a fixed table in the code, like the category tree: `STATES` in `app/places.py`
and in `lib/places.ts`, held the same by a test. The official (ISO 3166-2:IN) and old codes (CT, UT, TS, OR, DN, DH)
are taken as these. A state is optional.

- **Written with the place, it's kept as written, and nothing else is asked.** That means a code in capitals after
  the place (", WB", " WB", " (WB)"), or a state's name after a comma ("Darjeeling, West Bengal"). An old code counts
  only after a comma or in brackets, because in "Goa OR Kerala", "OR" is a word. A place that is a state ("Goa",
  "Jammu and Kashmir") is that state.
- **Not written:** Ask Plutus first offers the state you gave the same name before.
- **Failing that, with the local AI set up,** the AI is asked about the place's words alone, never a payment and
  never the rest of the sentence (`POST /api/ask/place`). It gives the place's usual spelling and its state; a name
  found in several states (Aurangabad: MH and BR) comes back as one button per state. The server checks what it says:
  a state from the table, a short plain name, no repeats, at most four. The page shows it as a choice: *Mark as Mumbai,
  MH* with "you wrote “Mambaii”", *Keep as written*, *Cancel*.
- **Without the AI, or for a place it doesn't know,** the place is kept as written, and the card says it has no state
  and how to add one.
- **Places has a State list** (no search, no suggestions) to add or change one.
- **Shown everywhere as "Place, ST"**, the state's name on hover. Ask Plutus answers by state ("how much did I spend
  in West Bengal?") and by place in a state ("in Aurangabad, MH").

**Why**: the owner wanted a place's state, and misspellings caught ("mambaii"), and chose the local AI over a
downloaded list of towns: "instead of downloading the list … we can use local LLM here", and "suggestion/search … No
need, keep it simple". The 36 states and union territories are the same for everyone and change only by law, so they
belong in the code, like the categories. Towns number in the thousands and change, so they're left to the AI the user
may already have. The model learns nothing of yours (a place's few words) and decides nothing: it suggests, and your
button keeps it (#30).

**Costs**:
- Without the local AI, a place's spelling isn't checked, and its state is only what you write.
- Codes in small letters aren't read: "up", "as" and "or" are words, so the AI reads those cases. Codes in a
  sentence written all in capitals aren't read either.
- "London, UK" reads as Uttarakhand. The card names the state, so this shows before it's kept.

**Where**: `STATES`, `region_code` and `place_name` in `app/places.py`; `read_place` in `app/ask.py`; `POST
/api/ask/place` in `app/routes/system.py` (`tests/test_places.py`, `tests/test_ask.py`). On the page:
- `STATES`, `placeLabel`, `placeMatches`, `stateAt`, `parsePlace` and `toldBefore` in `lib/places.ts`;
- `readStay` and the question's places in `lib/askRules.ts` (`web/tests/places.test.ts`);
- the told card in `components/AskPanel.tsx`, and the State list in `components/dash/Places.tsx`;
- the state steps in `scripts/checks/walkthrough.mjs`.
