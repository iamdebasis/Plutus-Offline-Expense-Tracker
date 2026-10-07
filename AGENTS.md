# Plutus: working on it, for AI agents and people

Plutus is a local-only expense tracker for India: card statements, payment-app histories and UPI screenshots in, one
honest dashboard out, all on the user's Mac. This file is the entry point for any coding agent (Claude Code, Codex,
Cursor, Copilot, Gemini CLI, Aider, a local model…) and for people. `CLAUDE.md` and `GEMINI.md` only point here.

Read next, as the work needs:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the system map: processes, how a file becomes numbers, every module,
  route and data file, the invariants, how to add a feature, a glossary.
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are. Don't undo a decision without reading it.
- [docs/READERS.md](docs/READERS.md): card statements: banks' layouts, diagnosing a statement, changing a reader.
- [docs/GUIDE.md](docs/GUIDE.md): what the user sees and how every number is made.
- [docs/ROADMAP.md](docs/ROADMAP.md): what's been discussed but not built, and known limits.

## Core values: never broken

1. **No user data leaves the Mac.** No file, transaction or name is sent to any server or online service for
   processing.
2. **No user data is hardcoded.** Nothing about a particular person in code, tests or docs.
3. **Everything about a user lives in the data folder** (`data/`), so a new user starts from a blank slate.
4. **Every operation is local**, with a local AI (Ollama) as the only AI, and optional.

Check every change against these four. If something would bend one, don't build it; say why.

## The standard

- **Design like a lead UI/art designer**: consistent with the existing look (neutral dark glass, zinc greys, green only
  for money coming in, amber to look at, rose for danger); clear, plain wording; a calm, worded state for empty, busy,
  error and done; accessible; checked in a real browser.
- **Build like a senior lead architect**: fix the general cause, not one case; one source of truth; safe by default
  (recoverable, guarded, never half-done); decisions written down in [docs/DECISIONS.md](docs/DECISIONS.md).
- **Deliver like a lead delivery person**: a test that fails without the change, the whole suite green, an end-to-end
  check on scratch data, the docs updated, a sweep for anything personal before committing, and an honest account of
  what was done and what wasn't.

## Hard rules: the user's data never leaves this machine

- **Never read, cat, grep or open anything under `data/`.** It holds the user's real ledger, payee names and their
  original files (`data/uploads`), and anything read into an AI session is sent to that model's provider. Work from
  fake data.
- **Everything about the user lives in `data/`**, nowhere else: originals always go to `data/uploads`
  (`app/storage.py`; there's no setting to keep them elsewhere), and the tools' temporary copies and outputs go to
  `data/run` and `data/redacted`, never the system's temp folder. A new user starts from nothing; **Start over** (Your
  vault, `app/reset.py`, `POST /api/reset`) moves what `userdata.py` lists to the macOS Trash and the app is a fresh
  clone again (refused while reading; tests use a fake Trash, `conftest.fake_trash`). Deleting `data/` with the app
  stopped does the same, unrecoverably.
- Real statements are read only when their owner explicitly allows it, outside the repo. Never copy them, or any name,
  number, ID or amount from them, into the repo: not into tests, fixtures, docstrings, comments or docs. Examples use
  obviously fake data ("Mr Fake Payee", "XX1111", "900000000001").
- This repo is public. `.gitignore` and `scripts/git-hooks/pre-commit` (turned on by `make setup`) keep `data/`,
  `samples/`, statements, exports and screenshots out of git; don't weaken either.
- **Nothing about a particular person in the code, ever**: no names (a landlord, a friend), no account or card digits,
  no card networks or which cards someone holds, no choices (a category someone picked, a setting). All of that is
  user data and lives in `data/`, reached only through `app/userdata.py` (which lists every file; add new ones there).
  The code holds only what's the same for everyone: the category tree, public merchants, card designs, parsing rules.
  Card designs are per bank (`web/src/components/cards/skins.tsx`), never per card product: a picture of someone's
  card is theirs (`data/card-art/`, served by `/api/card-art`, matched in `web/src/lib/cardArt.ts`).
  `tests/test_own_accounts.py` fails if a module reaches the data folder directly or carries a real-looking account
  number. Defaults come from the seed (e.g. the category tree's `excludeFromSpend`), never from one person's taste.
- No network calls from app code except to `127.0.0.1` (Ollama). No CDN scripts, fonts or analytics in the UI.
  `backend/tests/conftest.py` blocks non-loopback sockets, the real LLM, and this Mac's Ollama (its server and its
  models folder) in every test; keep it that way.
- The LLM host is validated to be loopback in `app/config.py`. Plutus never downloads a model or installs anything.

## How to work

- **Ad-hoc runs never touch the user's data**: any command that imports `app.main`, starts the server or builds a
  `TestClient` outside pytest gets `ET_DATA_DIR=<a scratch folder>` on the same line (and its own `ET_PORT`, and
  `ET_OLLAMA_HOST=127.0.0.1:9` unless the AI is under test). pytest is safe: `conftest.py` gives every test its own
  data folder.
- **End-to-end checks** run on such a scratch server, in a headless browser, with made-up files (`tests/fake_cards.py`,
  `tests/statement_gen.py`); Start over there must use a scratch Trash. Never on the user's running Plutus.
- **Tests first**: a test that fails without the change, with fake data; then switch the change off once to see it
  fail. Other readers or rules can mask a missing fix.
- Don't run the `ollama` command-line client to inspect models (it opens the Ollama app); use its HTTP API on
  127.0.0.1:11434.
- In zsh an unmatched glob aborts the whole command: delete by pattern with `find`, not `rm`.
- Before committing: `make test`, and grep the diff for anything personal. Ask the person you work for before
  commits, pushes, or anything that removes data.
- Keep the docs true: a new module, route or data file gets its line in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
  (`backend/tests/test_docs.py` checks); a decision goes in [docs/DECISIONS.md](docs/DECISIONS.md).

## Commands

| Command | What it does |
|---|---|
| `make check` | What this Mac needs, how to get it, and which local model suits it |
| `make setup` | Once: Python and web packages, the commit guard |
| `make start` | Build the page and serve Plutus at http://127.0.0.1:8000 |
| `make dev` | Backend on 8000 + Vite on 5173 with hot reload |
| `make test` | Backend tests (network blocked) + the page's money checks + TypeScript |
| `make measure` | 1000 random fake statements: none wrong, none unread |
| `make demo` | A made-up year at http://127.0.0.1:8001, in `.demo/`, never `data/` |
| `make inspect FILE=…` | What the detector and reader see in a PDF, masked |

Backend tests alone: `cd backend && .venv/bin/python -m pytest -q`. Web: `cd web && pnpm test && pnpm typecheck`.

## Layout

- macOS only. `scripts/check.sh` (`make check`, run by `make setup`) lists requirements and finds a Python 3.12+
  (macOS's own `python3` is 3.9). Ollama is optional: the app must work fully without it. `app/llm/advice.py`
  (standard library only; `make check` runs it) reads this Mac and Ollama and suggests the model that suits it; the
  Local AI panel (`/api/llm/setup`, the header's pill) shows the steps for the user to run. The model used:
  `ET_OLLAMA_MODEL`, else the user's pick (`data/settings.json`), else the best downloaded one for this Mac
  (`app/llm/setup.py`), else none ("not set up").
- `backend/`: FastAPI + PyMuPDF + Apple Vision (pyobjc), Python 3.12+. Venv at `backend/.venv`.
- `web/`: Vite + React 19 + Tailwind 4 + motion. `pnpm typecheck`, `pnpm build` (served by FastAPI from `web/dist`),
  `pnpm test` (Node's own test runner on `web/tests/`: the dashboard's arithmetic on fake ledgers; Node 22.18+).
- `make demo` runs Plutus on a made-up year (`app/tools/demo.py`) in `.demo/`, never `data/`, on port 8001 with the AI
  off. `make screenshots` takes the README's pictures (`docs/screenshots/`) from it; `scripts/screenshots.mjs` refuses
  any server whose data isn't `.demo/data`. Never take or commit screenshots of a real dashboard.
- Storage is plain JSON files written atomically via `app/jsonstore.py`. No database, by the owner's choice.
- JSON is camelCase on disk and over the API (Pydantic models in `app/models.py`).

## Pipeline

- `app/ingest/detect.py`: identify a file on upload (cheap, never the LLM). Bump `DETECTOR_VERSION` in
  `app/imports.py` when it changes; old uploads are re-identified at startup.
- `app/ingest/textlines.py`: positioned lines per page (text layer → decoded scrambled fonts via OCR → OCR).
- `app/parsers/`: one deterministic parser per source; returns `ParseResult` (`notes` = per-part summary lines).
  `gpay_takeout.py` reads Google Takeout zips (folders are packed into a zip by `POST /api/uploads/folder`); its
  tests use the fake export in `tests/fake_takeout.py`. Reader versions are per kind of file (`PARSER_VERSIONS` in
  `app/imports.py`): bump only the kind that improved; skipped files are retried too.
- Card statements (`card_statement.parse` → `statement_reader.py`): read two ways, by the table header
  (`card_statement.read_rows`) and by shape (`shape_reader.py`: tokens for dates/amounts in any form, rows = a date
  and an amount, columns from where figures line up), each under every meaning of the marks (`Convention`).
  `decide()` keeps a reading only when the statement's arithmetic proves it (previous balance − credits + debits =
  total due to the paisa; with no balances printed, its printed totals of debits and of credits; or a running
  balance); else the statement is **on hold**: its rows wait in `CardStatement.held`, out of the ledger and of billing,
  until the user confirms or corrects them (`/api/card-statements/{id}/confirm|held`). Never count an unproven row. A
  year's file is split by `segments()` into statements `upload~1`, `upload~2`…; a summary of several statements (a
  year-end statement) is proven over their cycles (`covered`, `_by_cycles`), its rows past them a held part of their
  own. Rows always cite the file itself (`SourceRef.upload` never has "~"). **docs/READERS.md is the maintainer's
  guide**: banks' layouts (researched), the pipeline, diagnosing with `make inspect`, and the procedure for a reader
  change (fake layout + failing test, general fix, `make test`, `make measure` must show 0 wrong/misread/unrecognised,
  bump `PARSER_VERSIONS`). `statement_ai.py` asks the local model about held or unreadable statements (tagged lines in
  20-line chunks; it answers with ids, never figures; answers cached in `data/statement_ai.json`); its reading counts
  only if proven, or if it equals the rules' reading when there's nothing to check against ("agreed"); a file with no
  figures longer than `UNCHECKED_PARTS` questions isn't sent (it can only agree, slowly). Statements are kept in
  `data/card_statements.json` (`app/statements.py`). Tests: `tests/statement_gen.py` (random layouts; every one proven
  exactly or held, none wrong), `tests/fake_cards.py`; never real statement values, not even a fee amount or a card's
  first digits. A row paid over UPI with the card is channel "upi" (UPI spends); `refs.cardRow` marks any statement
  row, whatever its channel. `card_export.py` reads the bank's CSV/XLSX exports of a span into the same rows.
- `app/billing.py`: which card an app's "XXXX99" is (RuPay first, never guessed when unclear) and what each bill paid
  for: its cycle (`pays_from`/`pays_to`, from the card's statements or guessed), `covered_by` a statement or an export
  that lists the cycle whole, and `estimate` (bill − what's counted one by one in the cycle). A bill is an app's
  record (CRED) or, when no app recorded that payment, a statement's own payment row (`statement_bills`,
  `origin: "statement"`, made again each time); both are placed alike. Runs at startup, after imports, deletes and
  network changes (`ledger.place_cards`), and after every edit of the ledger (`@ledger.exclusive`).
- Card bill payments, either side, are never spending or money in. A statement's bill payment
  (`categorize.statement_bill`) is never moved by a name-based answer; the page asks before one row is filed elsewhere.
- Google Pay: don't ask for a user's export. They run `make inspect-takeout` (masked structure only) and share that if
  something's off.
- `app/storage.py`: the folder for originals. Stored paths are relative to it; always go through
  `storage.file_path(rec)`.
- `app/imports.py`: background worker (parse → ledger upsert → categorize → LLM for new names).
- `app/ledger.py`: dedupe rules live in `_keys` / `_can_be_same`; see the tests before changing them. Edits hold the
  ledger's lock (`ledger.editing()`, `@ledger.exclusive`, which places the bills again once the edit is saved).
- `app/categorize.py`: rule order is documented at the top of the file. Only use the LLM via `llm.session()`.

## UI

- Charts follow a validated palette in `web/src/index.css` (`--color-series-*`), thin marks, one filter row, a table
  view for every chart. Colours follow the entity: `colourSlots` in `web/src/lib/totals.ts` fixes a category's colour
  from all-time totals (`cardColours` in `lib/cards.ts` a card's); never assign colours by rank within a period.
  Month-by-month lines (categories in Total spend, cards in Credit cards) are one shared component,
  `components/dash/Trends.tsx`: a `Trend` per line, with its estimated months dashed and gaps as null.
- Total spend (`web/src/lib/totals.ts`) must never double count: bills are placed and netted on the server
  (`app/billing.py`), the dashboard spreads each `estimate` over its cycle. The UPI section + the card section
  (`lib/cards.ts`, `CardSpending.tsx`: card-number purchases only) = Total spend, for every year and card filter.
- Investments can be left out (`web/src/lib/scope.ts`, the switch by the years; the choice is in `data/settings.json`
  via `/api/preferences`): the dashboard works on the scoped ledger; left-out payments live in `data.leftOut`, used
  only for the "left out" note and card-bill subtraction (investments paid by card must still come off the bill).
  Years and colour slots come from the unscoped ledger. Browser storage is only for how panels were left (collapsed,
  ticks), never for choices that change numbers.
- Rows where money comes in carry a green tag (`rowTag` in `lib/ledger.ts`); a card bill's amount is grey, unsigned.
- One payment, one row: every side of a card bill payment points to its bill (`settles`: the UPI payment, the
  statement's "PAYMENT RECEIVED"; set in `categorize.link_card_bills` and `billing.statement_bills` when bills are
  placed). The transactions list folds them into the side you paid from (`oneRowPerPayment`, "+ Statement"), and a
  change of category changes every side. A file's own rows and an answer's payments are never folded.
- Ask Plutus (the gold orb in the dashboard's corner, `components/AskOrb.tsx`): the AI reads the question, Plutus
  computes the answer. Rules in the page (`lib/askRules.ts`) read it into a query; only when they're unsure does the
  local AI (`app/ask.py`, `POST /api/ask`) read it, given the question, today and the category tree, **never a
  transaction**. `lib/ask.ts` works out the answer with the dashboard's own functions; `web/tests/ask.test.ts` holds it
  equal to the dashboard. A new kind of question is a new query kind there, never a model writing the answer.
- Own accounts: `app/accounts.py` (`data/accounts.json`, last four digits only). Ignoring a bank-account payee marks
  it; the AI pill shows the model's state (`asleep` unless loaded), never the server's.
