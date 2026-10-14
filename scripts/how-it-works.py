"""Draws the README's diagram, docs/how-it-works.svg: how Plutus turns your files into the dashboard, in the app's own
look (its canvas, panels, zinc text and gold; Lucide icons). Change this and run it (python3 scripts/how-it-works.py),
never the picture by hand. Every line of text is tagged with the room it has (data-max), so a check can measure it in
a browser; keep a line within about 90% of its room, so it still fits where the system font is wider than the Mac's.
"""

import re
from html import escape
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "docs" / "how-it-works.svg"

W = 960
M = 32
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif"
INK, SOFT, MUTED, GOLD = "#f4f4f5", "#a1a1aa", "#888893", "#f7b32d"
PANEL, TILE = "#0f1219", "#161a22"
LOCK = '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
SPARK = ('<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 '
         '1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 '
         '0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>')

out: list[str] = []


def text(x, y, s, size=13.5, fill=SOFT, weight=400, max_w=None, anchor="start"):
    fit = f' data-max="{max_w}"' if max_w else ""
    out.append(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{fit}>'
               f'{escape(s)}</text>')


def icon(paths, x, y, size, stroke):
    out.append(f'<g transform="translate({x} {y}) scale({size / 24})" fill="none" stroke="{stroke}" stroke-width="2" '
               f'stroke-linecap="round" stroke-linejoin="round">{paths}</g>')


def tile(x, y, w, h, title, lines, ai=False):
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{TILE}" stroke="#ffffff" stroke-opacity="0.07"/>')
    top = y + (h - (22 + 19 * len(lines))) / 2 + 15
    text(x + 16, top, title, 15, "#e4e4e7", 600, w - 32 - (16 if ai else 0))
    for i, line in enumerate(lines):
        text(x + 16, top + 23 + 19 * i, line, 13.5, SOFT, 400, w - 32)
    if ai:
        icon(SPARK, x + w - 26, y + 10, 14, GOLD)


def arrow_right(x0, x1, y):
    out.append(f'<path d="M{x0} {y}H{x1 - 1}" stroke="#4d525c" stroke-width="1.5"/>'
               f'<path d="M{x1 - 6} {y - 4.5}L{x1} {y}L{x1 - 6} {y + 4.5}" fill="none" stroke="#4d525c" stroke-width="1.5" '
               f'stroke-linecap="round" stroke-linejoin="round"/>')


def stage(n, y, h, name, about):
    out.append(f'<rect x="{M}" y="{y}" width="{W - 2 * M}" height="{h}" rx="18" fill="{PANEL}" stroke="#ffffff" '
               f'stroke-opacity="0.07"/>')
    cx, cy = M + 34, y + 34
    out.append(f'<circle cx="{cx}" cy="{cy}" r="14" fill="{GOLD}" fill-opacity="0.12" stroke="{GOLD}" stroke-opacity="0.55"/>')
    text(cx, cy + 5, str(n), 14, GOLD, 700, anchor="middle")
    text(M + 58, cy + 6, name, 17, INK, 650, 120)
    for i, line in enumerate(about):
        text(M + 20, y + 72 + 18 * i, line, 13, MUTED, 400, 150)


def down(y0, y1):
    x = M + 34
    out.append(f'<path d="M{x} {y0 + 3}V{y1 - 3}" stroke="{GOLD}" stroke-opacity="0.45" stroke-width="1.5"/>'
               f'<path d="M{x - 4} {y1 - 7}L{x} {y1 - 3}L{x + 4} {y1 - 7}" fill="none" stroke="{GOLD}" stroke-opacity="0.6" '
               f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>')


X0 = M + 176  # where a stage's steps start
X1 = W - M - 16  # and end
SPAN = X1 - X0
GAP = 18

# header
text(M, 62, "From your files to one honest dashboard", 24, INK, 650, 560)
text(M, 90, "Every step runs on your Mac, and every figure traces back to your files.", 14.5, SOFT, 400, 600)
pill_w = 228
px = W - M - pill_w
out.append(f'<rect x="{px}" y="42" width="{pill_w}" height="34" rx="17" fill="{GOLD}" fill-opacity="0.08" stroke="{GOLD}" '
           f'stroke-opacity="0.4"/>')
icon(LOCK, px + 16, 51, 16, GOLD)
text(px + 40, 64, "Nothing leaves your Mac", 13.5, "#f8c75a", 600, pill_w - 52)

# 1 · your files
y = 116
h = 112
stage(1, y, h, "Your files", ["drop them onto", "the page"])
w = (SPAN - 2 * 12) / 3
for i, (title, line) in enumerate([("Card statements", "any bank: PDF, CSV, Excel"), ("UPI app history", "PhonePe, CRED, Google Pay"),
                                   ("UPI screenshots", "a payment's receipt")]):
    tile(X0 + i * (w + 12), y + 16, w, h - 32, title, [line])
down(y + h, y + h + GAP)

# 2 · read
y += h + GAP
h = 150
stage(2, y, h, "Read", ["the same careful way,", "for every file"])
gap = 24
w = (SPAN - 3 * gap) / 4
steps = [("Identify", ["quick checks,", "never the AI"], False), ("Get the text", ["its own text, or", "on-device OCR"], False),
         ("Read the rows", ["one reader per", "kind of file"], False), ("Prove it", ["card statements", "must add up"], True)]
for i, (title, lines, ai) in enumerate(steps):
    x = X0 + i * (w + gap)
    tile(x, y + 16, w, 92, title, lines, ai)
    if i:
        arrow_right(x - gap + 5, x - 5, y + 16 + 46)
out.append(f'<circle cx="{X0 + 4}" cy="{y + 128}" r="2.5" fill="{GOLD}"/>')
text(X0 + 14, y + 132, "A card statement that doesn't add up to the paisa waits on hold for you. It's never guessed.",
     13.5, SOFT, 400, SPAN - 14)
down(y + h, y + h + GAP)

# 3 · make sense
y += h + GAP
h = 176
stage(3, y, h, "Make sense", ["kept in plain files,", "on your Mac"])
lw = 196
tile(X0, y + 16, lw, h - 32, "One ledger", ["each payment once,", "however many files", "it's in"])
rx = X0 + lw + 44
rw = X1 - rx
th = (h - 32 - 12) / 2
tile(rx, y + 16, rw, th, "Categories", ["your answers first, then rules, known shops and the local AI"], True)
tile(rx, y + 16 + th + 12, rw, th, "Card bills", ["each placed in the cycle it paid, so nothing is counted twice"])
mid = y + h / 2
fork = X0 + lw + 20
for ty in (y + 16 + th / 2, y + 16 + th + 12 + th / 2):
    bend = 8 if ty > mid else -8
    out.append(f'<path d="M{X0 + lw} {mid}H{fork - 8}Q{fork} {mid} {fork} {mid + bend}V{ty - bend}Q{fork} {ty} {fork + 8} {ty}'
               f'H{rx - 1}" fill="none" stroke="#4d525c" stroke-width="1.5"/>')
    out.append(f'<path d="M{rx - 7} {ty - 4.5}L{rx - 1} {ty}L{rx - 7} {ty + 4.5}" fill="none" stroke="#4d525c" '
               f'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>')
down(y + h, y + h + GAP)

# 4 · see and ask
y += h + GAP
h = 112
stage(4, y, h, "See and ask", ["answers from the", "same numbers"])
w = (SPAN - 12) / 2
tile(X0, y + 16, w, h - 32, "Dashboard", ["spending, UPI, cards, places, every payment"])
tile(X0 + w + 12, y + 16, w, h - 32, "Ask Plutus", ["ask in your words; Plutus does the maths"], True)

# the local AI
y += h + 22
h = 92
out.append(f'<rect x="{M}" y="{y}" width="{W - 2 * M}" height="{h}" rx="18" fill="#ffffff" fill-opacity="0.015" stroke="#ffffff" '
           f'stroke-opacity="0.2" stroke-dasharray="5 5"/>')
icon(SPARK, M + 22, y + 22, 18, GOLD)
text(M + 52, y + 37, "Local AI, optional, also on your Mac", 15, "#e4e4e7", 600, 600)
text(M + 52, y + 61, "It helps only where the rules aren't sure, at the marked steps: a statement that doesn't add up,",
     13.5, SOFT, 400, W - 2 * M - 72)
text(M + 52, y + 80, "a payee the rules don't know, a question they can't read. It never does the sums: Plutus does.",
     13.5, SOFT, 400, W - 2 * M - 72)
H = y + h + M

desc = ("How Plutus works, in four steps, all on your Mac. 1, your files: card statements (PDF, CSV or Excel), UPI app "
        "history (PhonePe, CRED, Google Pay) and UPI screenshots. 2, read: identify each file with quick checks, get its text, read its rows, and count a card "
        "statement only if it adds up to the paisa, else hold it for you. 3, make sense: one ledger with each payment once; "
        "categories from your answers, rules, known shops and the local AI; card bills placed in their cycle so nothing is "
        "counted twice. 4, see and ask: the dashboard, and Ask Plutus, which does the maths itself. The optional local AI "
        "only helps where the rules aren't sure, and never does the sums.")
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" '
       f'aria-labelledby="t d" font-family="{FONT}">\n'
       f'<title id="t">How Plutus works</title>\n<desc id="d">{escape(desc)}</desc>\n'
       '<!-- Drawn by scripts/how-it-works.py: change that, not this. Icons: Lucide (ISC licence). -->\n'
       '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1016"/>'
       '<stop offset="1" stop-color="#07090d"/></linearGradient></defs>\n'
       f'<rect width="{W}" height="{H}" rx="24" fill="url(#bg)"/>\n'
       f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="23.5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>\n'
       + "\n".join(out) + "\n</svg>\n")
svg = re.sub(r"\d+\.\d{3,}", lambda m: f"{float(m.group()):.2f}".rstrip("0").rstrip("."), svg)  # tidy: 0.01px is plenty
OUT.write_text(svg, encoding="utf-8")
print(f"{OUT.relative_to(OUT.parents[1])}: {W} by {H}")
