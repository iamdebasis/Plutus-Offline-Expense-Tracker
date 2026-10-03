"""A fake Google Pay Takeout export, laid out like the real one (fake data only).

The HTML follows Takeout's My Activity markup: one `outer-cell` per entry, the product in a title <p>, the action
and its timestamp in a body cell (separated by <br>), and "Products:" / "Details:" in a caption cell."""

import csv
import io
import json
import zipfile
from datetime import timezone
from pathlib import Path

ROOT = "Takeout/Google Pay"

# (action, timestamp as Takeout writes it, status under "Details:"; None for no Details section)
ACTIVITY = [
    ("Paid ₹250.00 to SWIGGY using Bank Account XXXXXX1111", "Sep 4, 2025, 2:30:45 PM IST", "Completed"),
    ("Paid ₹40.00 to FAKE TEA STALL using Bank Account XXXXXX1111", "4 Sept 2025, 18:05:10 GMT+05:30", "Completed"),
    ("Received ₹500.00 from Mr Fake Friend", "Sep 5, 2025, 9:15:00 PM IST", "Completed"),
    ("Paid ₹999.00 to FAKE GADGETS using Bank Account XXXXXX1111", "Sep 6, 2025, 11:00:00 AM IST", "Failed"),
    ("Sent ₹100.00 to Ms Fake Sister using Bank Account XXXXXX2222", "Sep 6, 2025, 11:30:00 AM IST", "Pending"),
    ("Added ₹1,000.00 to UPI Lite using Bank Account XXXXXX1111", "Sep 7, 2025, 8:00:00 AM IST", "Completed"),
    ("Paid ₹20.00 to FAKE CHAI POINT using UPI Lite", "Sep 7, 2025, 8:05:00 AM IST", "Completed"),
    ("Used Google Pay", "Sep 7, 2025, 8:06:00 AM IST", None),
    ("Paid ₹1,234.50 to FAKE ELECTRICITY using Bank Account XXXXXX1111", "Jan 5, 2025, 9:07:03 AM IST", "Completed"),
    ("Received ₹15.00 from Google Pay", "Sep 8, 2025, 10:00:00 AM IST", "Completed"),
    ("Paid ₹99.00 to Google Play using Bank Account XXXXXX1111", "Sep 9, 2025, 7:45:12 PM IST", "Completed"),
    ("Paid ₹600.00 to Ms Fake Neighbour using RuPay Credit Card XXXX99", "Sep 10, 2025, 1:01:01 PM IST", "Completed"),
    ("Requested ₹200.00 from Mr Fake Friend", "Sep 11, 2025, 1:00:00 PM IST", "Completed"),
]

SENDS = [  # Money sends and requests.csv
    {"Time": "Sep 5, 2025, 9:15 PM", "Transaction ID": "FAKETXN0001", "Description": "Received from Mr Fake Friend", "Memo": "dinner share",
     "Type": "Received money", "Status": "Complete", "Amount": "₹500.00"},
    {"Time": "Sep 12, 2025, 6:00 PM", "Transaction ID": "FAKETXN0002", "Description": "Sent to Mr Fake Cousin", "Memo": "",
     "Type": "Sent money", "Status": "Complete", "Amount": "₹300.00"},
    {"Time": "Sep 11, 2025, 1:00 PM", "Transaction ID": "FAKETXN0003", "Description": "Request to Mr Fake Friend", "Memo": "",
     "Type": "Request", "Status": "Unpaid", "Amount": "₹200.00"},
]

GOOGLE = [  # Google transactions/transactions_123456.csv
    {"Time": "Sep 9, 2025, 7:45 PM", "Transaction ID": "GPA.0000-1111-2222-33333", "Description": "Google Play", "Product": "Google Play Apps",
     "Payment method": "UPI: Bank Account ••1111", "Status": "Complete", "Amount": "₹99.00"},
    {"Time": "Sep 20, 2025, 10:00 AM", "Transaction ID": "GPA.0000-1111-2222-44444", "Description": "YouTube Premium", "Product": "YouTube",
     "Payment method": "Visa •••• 4242", "Status": "Complete", "Amount": "₹149.00"},
    {"Time": "Sep 21, 2025, 10:00 AM", "Transaction ID": "GPA.0000-1111-2222-55555", "Description": "Google One", "Product": "Google One",
     "Payment method": "Visa •••• 4242", "Status": "Refunded", "Amount": "₹130.00"},
]

REWARDS = [  # Rewards earned.csv
    {"Rewarded on": "Sep 8, 2025", "Reward": "Cashback for paying a bill", "Amount": "₹15.00"},
    {"Rewarded on": "Sep 9, 2025", "Reward": "Scratch card: 10% off at a partner store", "Amount": ""},
]

GROUPS = {
    "Group_expenses": [
        {"creation_time": "2025-09-05T15:00:00.000Z", "creator": "Me", "group_name": "Dinner", "total_amount": "₹1,500.00",
         "state": "COMPLETED", "title": "Fake dinner", "items": [{"amount": "₹500.00", "state": "PAID_RECEIVED", "payer": "Mr Fake Friend"}]},
        {"creation_time": "2025-09-12T10:00:00.000Z", "creator": "Me", "group_name": "Trip", "total_amount": "₹900.00",
         "state": "ONGOING", "title": "Fake trip", "items": [{"amount": "₹300.00", "state": "UNPAID", "payer": "Mr Fake Cousin"}]},
    ]
}


def activity_html(entries=ACTIVITY) -> str:
    cells = []
    for action, when, status in entries:
        caption = "<b>Products:</b><br>&emsp;Google Pay<br>" + (f"<b>Details:</b><br>&emsp;{status}<br>" if status else "")
        cells.append(
            '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">'
            '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">Google Pay<br></p></div>'
            f'<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">{action}<br>{when}<br></div>'
            '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>'
            f'<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">{caption}</div>'
            "</div></div>"
        )
    return f'<html><head><meta charset="UTF-8"><title>My Activity</title></head><body><div class="mdl-grid">{"".join(cells)}</div></body></html>'


def activity_json() -> str:
    """The same activity as Takeout's JSON: UTC times, status under "details"."""
    from app.parsers.gpay_takeout import _when

    items = []
    for action, when, status in ACTIVITY:
        utc = _when(when).astimezone(timezone.utc)
        item = {"header": "Google Pay", "title": action, "time": utc.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "products": ["Google Pay"]}
        if status:
            item["details"] = [{"name": status}]
        items.append(item)
    return json.dumps(items, ensure_ascii=False)


def _csv(rows: list[dict]) -> str:
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=list(rows[0]))
    w.writeheader()
    w.writerows(rows)
    return out.getvalue()


def files(fmt: str = "html") -> dict[str, str]:
    """Every file of the export, by its path inside the zip."""
    activity = (f"{ROOT}/My Activity/My Activity.html", activity_html()) if fmt == "html" else (f"{ROOT}/My Activity/My Activity.json", activity_json())
    return {
        activity[0]: activity[1],
        f"{ROOT}/Money sends and requests/Money sends and requests.csv": _csv(SENDS),
        f"{ROOT}/Google transactions/transactions_123456.csv": _csv(GOOGLE),
        f"{ROOT}/Rewards earned/Rewards earned.csv": _csv(REWARDS),
        f"{ROOT}/Group expenses/Group expenses.json": json.dumps(GROUPS, ensure_ascii=False),
        f"{ROOT}/Saved passes/passes.json": "[]",  # something the reader doesn't know: reported, not read
        "Takeout/Chrome/History.json": "{}",  # another Google product in the same export: ignored
        "Takeout/archive_browser.html": "<html></html>",
    }


def make_takeout(path: Path, fmt: str = "html") -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, text in files(fmt).items():
            zf.writestr(name, text)
    return path
