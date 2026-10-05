"""The card statement readers on random statements, as a person adding them would: identified, read, decided.
`make measure` (or `python -m tests.measure_readers 1000`). Fake data only (tests/statement_gen.py).

What must hold, for every change to a reader:
  - WRONG: 0. A statement proven or confirmed with rows that differ from the truth is the one failure that matters.
  - held, reading off: 0. A statement on hold shows its rows for you to check; they must be the true ones.
  - HELD THOUGH CHECKABLE: 0. A statement that prints figures its rows can be proven by must be proven.
  - NOT RECOGNISED, failed: 0.
"""

import os
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

work = Path(tempfile.mkdtemp(prefix="plutus-measure-"))
os.environ["ET_DATA_DIR"] = str(work / "data")  # never your data folder: the readers register the fake cards they read

from app.ingest.detect import detect  # noqa: E402
from app.parsers import ParseError, card_statement  # noqa: E402
from tests.statement_gen import generate, render  # noqa: E402


def main(n: int) -> int:
    out: Counter = Counter()
    bad = []
    for seed in range(n):
        st = generate(seed)
        path = render(st, work / f"s{seed}.pdf")
        det = detect(path, path.name)
        if det.kind != "cc_statement":
            out["NOT RECOGNISED"] += 1
            bad.append((seed, "not recognised", det.label))
            continue
        try:
            res = card_statement.parse(path, f"upl_{seed}", det)
        except ParseError as e:
            out["failed"] += 1
            bad.append((seed, "failed", str(e)[:60]))
            continue
        rows = res.transactions + [t for x in res.statements for t in x.held]
        exact = sorted((t.at.date(), t.amount, t.direction == "credit") for t in rows) == st.truth()
        statuses = [x.status for x in res.statements]
        if st.style.kind == "year":
            expected = ["proven"] + (["on_hold"] if st.after else [])
        else:
            checkable = st.previous is not None or st.running_from is not None or st.style.totals
            expected = [("proven" if checkable else "on_hold")] * len(st.parts or [st])
        if "proven" in statuses and not exact:
            out["WRONG"] += 1
            bad.append((seed, "WRONG", res.statement.proof[:80]))
        elif not exact:
            out["held, reading off"] += 1
            bad.append((seed, "held, reading off", res.statement.proof[:80]))
        elif statuses != expected:
            out["HELD THOUGH CHECKABLE"] += 1
            bad.append((seed, f"statuses {statuses}, expected {expected}", res.statement.proof[:80]))
        else:
            out["proven" if statuses[0] == "proven" else "held, nothing to check it by"] += 1
    print({k: out[k] for k in ("proven", "held, nothing to check it by", "WRONG", "held, reading off", "HELD THOUGH CHECKABLE",
                                "NOT RECOGNISED", "failed")}, f"of {n} random statements")
    for b in bad[:20]:
        print("  ", *b)
    return 1 if bad else 0


if __name__ == "__main__":
    try:
        code = main(int(sys.argv[1]) if len(sys.argv) > 1 else 1000)
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the fake statements it made
    sys.exit(code)
