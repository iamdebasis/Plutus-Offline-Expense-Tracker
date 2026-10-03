"""Your choices about what the numbers include, kept with your other settings in data/settings.json.

Only choices that change your figures live here; how a panel was left (collapsed, which lines are ticked) is
remembered by the browser. A choice you haven't made yet falls back to the category tree, so the code never
carries anyone's preference.
"""

from app import categorize, userdata
from app.models import Model


class Preferences(Model):
    count_investments: bool  # SIPs, brokers, mutual funds as spending, or left out (tracked elsewhere)


def _file():
    return userdata.json_file("settings.json", default=dict)


def _defaults() -> dict:
    # the category tree marks investments as not spending, so until you choose, they're left out
    return {"countInvestments": not categorize.category_ids()["investments"].get("excludeFromSpend", False)}


def get() -> Preferences:
    saved = _file().read()
    return Preferences.model_validate({key: saved.get(key, value) for key, value in _defaults().items()})


def update(changes: dict) -> Preferences:
    known = {k: v for k, v in changes.items() if k in _defaults() and v is not None}
    _file().update(lambda s: {**s, **known})
    return get()
