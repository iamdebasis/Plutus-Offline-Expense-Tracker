"""Your settings, in data/settings.json: what the numbers include, and the local AI's (the model you chose in its
panel, and whether you've seen its one-time hint).

How a panel was left (collapsed, which lines are ticked) is remembered by the browser instead. A choice you haven't
made yet falls back to the category tree (or, for the model, to the best one downloaded for this Mac), so the code
never carries anyone's preference.
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


# ---- the local AI (app/llm/setup.py) --------------------------------------------------------------------------------


def ai_model() -> str | None:
    """The model you chose in the Local AI panel; None: Plutus picks the best one downloaded for this Mac."""
    chosen = _file().read().get("aiModel")
    return chosen if isinstance(chosen, str) and chosen else None


def set_ai_model(name: str | None) -> None:
    _file().update(lambda s: {**{k: v for k, v in s.items() if k != "aiModel"}, **({"aiModel": name} if name else {})})


def ai_hint_seen() -> bool:
    """Whether you've answered the one-time hint about the local AI (it shows after an import leaves things waiting)."""
    return _file().read().get("aiHintSeen") is True


def see_ai_hint() -> None:
    _file().update(lambda s: {**s, "aiHintSeen": True})
