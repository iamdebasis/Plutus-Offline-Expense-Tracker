# How Plutus reads card statements, and how to keep it reading them

For whoever maintains the readers. The user-facing side (what each state means, what you see in Your vault) is in
the [guide](GUIDE.md#credit-card-statements).

## The rule everything follows

There is no reader per bank. Every statement is read by its **structure** (dates, amounts, where they line up), and
a reading counts only when the **statement's own arithmetic proves it**. A statement nothing proves is **held**: shown
in Your vault, never counted, until the owner confirms it. Every figure Plutus stores is one the statement prints; no
step, the local AI included, may create or change a number.

A reader change is good when it makes more statements provable and never makes one wrong. `make measure` and the
tests say which.

## How banks make statements

From the banks' own help pages, their terms (MITC/KFS), open-source parsers of their statements, and the statements
owners allowed us to read for this work (masked). Generic research only: nothing from anyone's statement is in this
repo.

| Bank | What its statements do | How the reader copes |
|---|---|---|
| HDFC, monthly (new layout, 2025–) | `DATE & TIME` printed `15/09/2026\| 14:05`; `TRANSACTION DESCRIPTION`; `REWARDS` (`+ 12`); `AMOUNT` with ₹ drawn as a "C" by its font and `+` before credits; a `PI` column of coloured dots (the bank's spend category; legend on page 1); an `EMI` badge (a word in a small pill) on purchases eligible for SmartEMI (₹2,500+); summary as a sum: Previous Statement Dues − Payments/Credits + Purchases/Debits + Finance Charges = Total Amount Due (rounded to the rupee); no statement date, only a due date; a note mentioning the Terms and Conditions above the table; page 1's table printed a few points to one side; long descriptions wrapped half above, half below their row | tokens read `C`, `+`; badges dropped as tags; the PI dot is a symbol, never a mark; the sum box read under wrapped labels; ±50 paise when the total is a whole rupee; the due date dates it; only a heading starts the terms; tables aligned to each other; the line above a row joins its description |
| HDFC, year-end statement & summary | Account summary of the year (Purchases & Debits, Payments & Credits, the day each month's statement is dated) under labels wrapped over two lines; a table of each month's statement (MAY-2025 …); every transaction: Date \| Description \| Amount \| DR/CR \| Card Number; the list can run past the last statement it sums up (the year's last month) | proven over the cycles of the statements it sums up (`covered`, `_by_cycles`); rows past them held as a part of their own; marks found with a column after them |
| SBI Card | `20 Aug 26`; `C` or `D` after every amount; a fee's GST printed on the line under the fee, **undated**; account summary a flattened table with `( ` )` (₹ as a backtick) and figures on the line below; due date `IMMEDIATE` when overdue | an undated line whose amount lines up under the row above is a row of its own, on its date; figures read below labels; IMMEDIATE = the statement date |
| ICICI | `Date \| SerNo. \| Transaction Details \| Reward Points \| Intl.# amount \| Amount (in `)`; `CR` after credits; reward points negative on a refund; bold headings that read with **every letter twice** (`SSTTAATTEEMMEENNTT DDAATTEE`); figures below labels | bold read once (`_undoubled`, never a mask like `XXXX` or a plain number); the serial number isn't an amount |
| Axis, Kotak | Amount with `Dr`/`Cr`; sometimes a separate Cr/Dr column | marks read glued or in a column of their own |
| American Express (India) | Opening Balance − New Credits + New Debits = Closing Balance; Minimum Payment Due; dates like `August 14` (year from the statement); `CR` after credits | labels known; yearless dates take the statement's year |
| Any bank's site export | CSV, Excel or a PDF titled "Credit Card Transactions": no statement words, no totals | identified by a card plus a table of dated amounts; spreadsheets read cell by cell (`card_export.py`); held when nothing proves them, unless they print totals or a running balance |

Sources: [HDFC SmartEMI terms](https://v.hdfc.bank.in/content/dam/hdfc-aem-microsites/common-pdfs/pdf/SmartEMI_TC.pdf),
[HDFC: reading your statement](https://v.hdfc.bank.in/amp/learning-center/borrow/how-to-understand-credit-card-statement.html),
[hdfc-cc-parser-rs](https://github.com/joeirimpan/hdfc-cc-parser-rs) (HDFC's 2025 layout),
[credit-card-spend-intelligence](https://github.com/tanumay-deb/credit-card-spend-intelligence) (HDFC, ICICI and SBI
parsers), [Axis: how do I read my statement](https://application.axis.bank.in/webforms/axis-support/sub-issues/Cards-Credit-statement-3.aspx),
[American Express: understanding your statement](https://www.americanexpress.com/au/credit-cards/manage-your-card/understanding-your-statement/).

## The pipeline

1. **Identify** (`app/ingest/detect.py`). A statement's words ("statement date", "total amount due", …), or a card
   named or masked plus a table of dated amounts (exports). Change it → bump `DETECTOR_VERSION` (old uploads are
   identified again at startup).
2. **Lines** (`card_statement.read_lines`). Positioned words per page from the PDF's text; decoded or OCR'd when the
   text layer is scrambled or missing. Badges (a short word alone in a small filled shape) are dropped; bold drawn
   twice is read once. A page's number ("Page 16 of 19", "Page 16/19") is dropped wherever on a line it is
   (`_without_page_numbers`): printed just under a page's last row, in its description's column, both readers took it
   for a wrapped description ("… Page 16 of"). Tests: `fake_cards.datetime_rewards_paged` and `two_pages(footer=…)`.
3. **The statement's own figures** (`card_statement.read_summary`). Labels (`_LABELS`) with their figure beside them,
   after them, or below them, under labels wrapped over up to three lines (`_wrapped_labels`); a label never runs
   across two cells (`_across_cells`); the terms' worked examples are skipped (`in_terms`). A summary of several
   statements adds its months (`statement_months`) and the day they're dated.
4. **Readings.** Two readers, each under every meaning a statement can give its marks (`Convention`):
   - the table reader (`card_statement.read_rows`), by the header's columns;
   - the shape reader (`shape_reader.py`): tokens (dates, times, amounts in any form), rows (a date at the start and
     an amount after it), continuation lines, columns where amounts line up, tables aligned to the biggest one,
     layouts (one amount; debit and credit columns; an amount and a running balance).
5. **Decide** (`statement_reader.decide`). The proofs, in order:
   - previous balance − credits + debits = total due, to the paisa (within 50 paise when the total is a whole rupee);
   - with no balances printed, its totals of debits and of credits, each to the paisa; for a summary of several
     statements, over their cycles (`_by_cycles`), the rows past them held as their own part;
   - a running balance that every row moves by exactly its amount.
   Exactly one set of rows passing is proof; two different sets passing, or none, is a hold, with the nearest reading
   shown and the reason in words.
6. **The local AI** (`statement_ai.py`), only for what's held or unread: tagged lines in parts of 20, answers as ids,
   never figures; counted only if the statement's arithmetic proves it (or, with nothing to check, if it matches the
   rules row for row); a summary's own figures are never taken for rows; long files with nothing to check aren't sent.
7. **The ledger.** Rows are found again by their place on the statement (`refs.cardRow`), so a better reader updates
   them and keeps what the owner set; answers for one payment are also kept by row (`data/row_answers.json`).

## When a statement doesn't read

The owner sees it held in Your vault with the reason ("no reading of the rows adds up to …", with the figures
compared). They don't need to send the file. `make inspect FILE=…` prints its structure masked (letters as X, digits
as 9): the summary figures found, each reading's row count, where amounts line up, and a flag per line ([H] header,
[D] date, [A] amount, [S] row by shape, [E] end). That's enough to see which step failed:

| Symptom in `make inspect` | Where to look |
|---|---|
| "Unrecognised" at the top | `detect.py`: the words or the shape that identify it |
| summary figures missing | `_LABELS`, `_wrapped_labels`, `_value` (a figure's form) |
| rows by shape far fewer than lines with [D] | `shape_reader.find_rows` / `_continue`, `parse_date` |
| amounts line up at several x close together | `money_columns`, `_table_shifts`, `SHIFT` |
| proof fails by a whole row's amount | a row missed or misread: the [D]/[A] lines that aren't [S] |
| held: "within the cycles of …" | a summary of several statements: its months, day, or list's span |

## Changing a reader

1. **Reproduce it with fake data.** Add the layout to `backend/tests/fake_cards.py` as the bank makes it (its
   structure, its quirks; obviously fake names, cards and amounts), or a new dimension to
   `backend/tests/statement_gen.py` if it's a way statements vary.
2. **Write the test first**, and see it fail.
3. **Fix the general cause**, not the bank: what makes this layout hard is a structure other banks share.
4. **Prove the test is needed**: switch the fix off and check the test fails.
5. **Run everything**: `make test`, then `make measure` (1000 random statements through identification, reading
   and deciding: WRONG, misread, unrecognised and failed must all be 0).
6. **Bump the version**: `PARSER_VERSIONS["cc_statement"]` in `backend/app/imports.py`, with a line saying what
   changed. Every statement already added is read again at the next start; what the owner set is kept.

## Privacy, always

- Never read `data/`. Real statements are read only when their owner allows it, outside the repo, masked when
  reported, and never copied: no name, number or amount from one goes into code, tests or docs.
- Ad-hoc runs of the app or a TestClient set `ET_DATA_DIR` to a scratch folder; the tests do it themselves.
- Research with generic queries; nothing from anyone's statement leaves the machine.
