"""Show the *structure* of a Google Pay Takeout export, without its content, to debug the reader safely.

    python -m app.tools.inspect_takeout path/to/takeout.zip        (or the extracted folder)

Prints which files are there and how the reader routes them, how many entries each has, the *shapes* of
My Activity's lines (Google's own words stay; names, numbers and IDs become Xxxx and 9999, e.g.
"Paid ₹999.99 to XXXXXX using Bank Account XXXXXX9999"), CSV column names, and what the reader made of it, in
counts. No names, amounts or IDs; dates keep only their format ("Sep 9, 9999, 9:99 PM"). Read it before pasting
it anywhere.
"""

import html
import io
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path

from app import userdata
from app.parsers import gpay_takeout as g
from app.tools.inspect import shape

# Google's own words in Google Pay activity: kept, everything else masked.
GPAY_WORDS = {
    "paid", "sent", "received", "refunded", "recharged", "bought", "added", "transferred", "requested", "withdrew", "you",
    "payment", "to", "from", "for", "using", "bank", "account", "upi", "lite", "credit", "debit", "card", "rupay", "visa",
    "mastercard", "google", "pay", "play", "youtube", "one", "cashback", "reward", "rewards", "refund", "transaction", "id",
    "completed", "complete", "failed", "pending", "cancelled", "declined", "in", "progress", "unpaid", "success", "processing",
    "am", "pm", "ist", "gmt", "utc", "products", "details", "used", "linked", "money", "request", "scratch",
}


def mask(text: str) -> str:
    """Google's words stay; names, amounts and IDs keep only their shape ("₹999.99", "XXXXXX9999")."""
    words = " ".join(w if w.lower().strip(":,.()") in GPAY_WORDS else shape(w) for w in g._clean(text).split(" "))
    return re.sub(r"\d", "9", words)  # dates too: their format is what matters, not when you paid


def main(path: Path) -> None:
    if path.suffix.lower() == ".zip":
        return _inspect(path, path)
    packed = _pack(path)
    try:
        _inspect(path, packed)
    finally:
        packed.unlink(missing_ok=True)


def _inspect(path: Path, zpath: Path) -> None:
    print(f"Google Pay export: {path.name} ({zpath.stat().st_size // 1024} KB)\n")
    with zipfile.ZipFile(zpath) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        print("Files")
        for i in infos:
            kind = g._route(i.filename) if g._is_google_pay(i.filename) else None
            where = g._KINDS.get(kind, "not read") if g._is_google_pay(i.filename) else "other Google product"
            print(f"  {mask_path(i.filename):70s} {i.file_size // 1024:>6} KB → {where}")
        for i in infos:
            if not g._is_google_pay(i.filename):
                continue
            kind = g._route(i.filename)
            raw = zf.read(i)
            try:
                if kind == "activity":
                    _activity(raw, i.filename)
                elif kind in ("sends", "google", "rewards"):
                    _table(raw, i.filename)
                elif kind == "groups":
                    _groups(raw)
            except Exception as exc:  # noqa: BLE001: describe the file instead
                print(f"\n{mask_path(i.filename.split('/')[-1])}: the reader can't read it ({g._why(exc)})")
                print(f"  {_first_look(raw)}")
    print("\nWhat the reader made of it (counts only)")
    try:
        result = g.parse(zpath, "inspect")
        for line in result.notes + result.warnings:
            print(f"  {line}")
        print(f"  → {len(result.transactions)} transactions")
    except Exception as exc:  # noqa: BLE001 — show why, it's the point of this tool
        print(f"  couldn't read it: {exc}")


def mask_path(name: str) -> str:
    """Folder and file names are Google's own, except an export's id numbers."""
    return "".join("9" if c.isdigit() else c for c in name)


def _activity(raw: bytes, name: str) -> None:
    text = raw.decode("utf-8", errors="replace")
    items = list(g._activity_json(text) if name.lower().endswith(".json") else g._activity_html(text))
    print(f"\nMy Activity ({'JSON' if name.lower().endswith('.json') else 'HTML'}): {len(items)} entries")
    actions = Counter(mask(lines[0]) if lines else "(no text)" for lines, *_ in items)
    print("  lines, by shape (most common first):")
    for line, n in actions.most_common(25):
        print(f"    {n:>5} × {line}")
    if len(actions) > 25:
        print(f"    … and {len(actions) - 25} more shapes")
    times = Counter("read" if when else "unreadable" for _, when, *_ in items)
    print(f"  timestamps: {dict(times)}")
    if "html" in name.lower():
        raw_times = Counter(mask(_raw_time(chunk)) for chunk in text.split('class="outer-cell')[1:60])
        print(f"  timestamp shapes: {dict(raw_times.most_common(5))}")
    statuses = Counter(mask(status) if status else "(none)" for _, _, status, _ in items)
    print(f"  statuses: {dict(statuses.most_common())}")
    _unnamed(text, name)


def _unnamed(text: str, name: str) -> None:
    """Entries the reader saw a payment in but no name for (it calls them "Unknown"): everything in each entry,
    masked, and one of them as the page writes it, so the place Google puts the name shows."""
    shapes: Counter = Counter()
    markup = None
    for lines, when, status, everything, chunk in _entries(text, name):
        entry = g._from_action(lines, when, status, g.Report("inspect"), source="activity")
        if entry is None or entry.payee != "Unknown":
            continue
        shapes[" ⏎ ".join(mask(x) for x in everything)] += 1
        if markup is None and chunk is not None:
            markup = _masked_markup(chunk)
    print(f"  payments the reader found no name for: {sum(shapes.values())}")
    for shape, n in shapes.most_common(15):
        print(f"    {n:>5} × {shape}")
    if markup:
        print("  one of them as the page writes it (text masked, links and other attributes removed):")
        print(f"    {markup}")


def _entries(text: str, name: str):
    """Each entry as the reader sees it (its lines, time, status) plus all of its text, and its markup."""
    if name.lower().endswith(".json"):
        for item in g._records(g._json(text)):
            lines = [item.get("title", "")] + [s.get("name", "") for s in item.get("subtitles", []) if isinstance(s, dict)]
            details = [d.get("name", "") for d in item.get("details", []) if isinstance(d, dict)]
            lines = [ln for ln in map(g._clean, lines) if ln]
            yield lines, g._when(item.get("time", "")), " ".join(details) or None, [*lines, *details], None
        return
    for chunk in re.split(r'<div class="[^"]*\bouter-cell\b', text)[1:]:
        body = g._lines(g._cell(chunk, "mdl-typography--body-1"))
        when = next((d for d in (g._when(line) for line in reversed(body)) if d), None)
        lines = [line for line in body if not g._when(line)]
        status = g._caption_status(g._lines(g._cell(chunk, "mdl-typography--caption")))
        yield lines, when, status, g._lines('<div class="outer-cell' + chunk), chunk


def _masked_markup(chunk: str) -> str:
    """An entry's HTML with every tag cut to its name and class (links and ids go) and every text masked."""
    def tag(m: re.Match) -> str:
        cls = re.search(r'\bclass="([^"]*)"', m.group(0))
        return f'<{m.group(1)}{f" class=\"{cls.group(1)}\"" if cls else ""}>'

    s = re.sub(r"<(\w+)\b[^>]*>", tag, '<div class="outer-cell' + chunk)
    s = re.sub(r">([^<]+)<", lambda m: ">" + mask(html.unescape(m.group(1))) + "<", s)
    return re.sub(r"\s+", " ", s)[:1500]


def _raw_time(chunk: str) -> str:
    lines = g._lines(g._cell(chunk, "mdl-typography--body-1"))
    return lines[-1] if lines else ""


def _table(raw: bytes, name: str) -> None:
    rows = g._rows(raw, name)
    print(f"\n{mask_path(name.split('/')[-1])}: {len(rows)} rows")
    if name.lower().endswith(".json"):
        print(f"  layout: {_json_shape(g._json(raw.decode('utf-8-sig', errors='replace')))}")
    if rows:
        print(f"  columns: {' · '.join(mask_path(str(k)) for k in rows[0])}")
        for row in rows[:3]:
            print("  row: " + " | ".join(f"{mask_path(str(k))}={mask(v if isinstance(v, str) else ' '.join(v or []))}" for k, v in row.items()))


def _first_look(raw: bytes) -> str:
    """What a file looks like from the outside: its size and how it starts, never what it says."""
    text = raw.decode("utf-8-sig", errors="replace").strip()
    if not text:
        return f"{len(raw)} bytes · empty"
    starts = {"<": "'<' (HTML or XML)", "{": "'{' (a JSON object)", "[": "'[' (a JSON list)", ")": "')' (Google's )]}' guard?)"}
    lines = text.count("\n") + 1
    return f"{len(raw)} bytes · {lines} line{'s' if lines != 1 else ''} · starts with {starts.get(text[0], 'plain text')}"


def _json_shape(data: object, depth: int = 0) -> str:
    """The structure of parsed JSON, keys only: object{rewards: list[3] of object{amount, time}}."""
    if depth > 3:
        return "…"
    if isinstance(data, dict):
        return "object{" + ", ".join(f"{mask_path(str(k))}: {_json_shape(v, depth + 1)}" for k, v in list(data.items())[:12]) + "}"
    if isinstance(data, list):
        return f"list[{len(data)}]" + (f" of {_json_shape(data[0], depth + 1)}" if data else "")
    return type(data).__name__.replace("str", "text").replace("NoneType", "null")


def _groups(raw: bytes) -> None:
    data = g._json(raw.decode("utf-8-sig", errors="replace"))
    groups = g._records(data)
    keys = sorted({mask_path(str(k)) for grp in groups for k in grp})
    print(f"\nGroup expenses: {len(groups)} notes · keys: {', '.join(keys)}")
    print(f"  layout: {_json_shape(data)}")


def _pack(folder: Path) -> Path:
    """An extracted folder, packed the way the app packs it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(folder.parent).as_posix())
    # inside the data folder, like everything made from your files; removed once it's been read
    out = userdata.path("run") / f"{folder.name}-inspect.zip"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(buf.getvalue())
    return out


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python -m app.tools.inspect_takeout path/to/takeout.zip (or the extracted folder)")
    main(Path(sys.argv[1]).expanduser())
