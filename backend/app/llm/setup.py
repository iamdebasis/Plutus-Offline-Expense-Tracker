"""The Local AI panel, and which model Plutus uses.

Plutus uses ET_OLLAMA_MODEL when it's set; else the model you chose in the panel, while it's downloaded; else the most
capable downloaded model that suits this Mac (the list is in app/llm/advice.py); else none, and the local AI is "not
set up". Plutus never downloads a model or installs Ollama: the panel shows the steps for this Mac, you run them, and
the next look at the status (every few seconds while Plutus is open) or the next job picks the model up.
"""

import re

from app import logs, preferences
from app.config import settings
from app.llm import advice, llm

log = logs.get("llm")
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}$")


async def _ollama(details: bool) -> advice.Ollama:
    """Ollama on this Mac, from its files; and from its server when it's running: its version is the one answering
    Plutus's questions, and its list of models is the one that counts."""
    found = advice.find_ollama()
    if version := await llm.server_version():
        found.running, found.version = True, version
        if (listed := await llm.models(details=details)) is not None:
            found.models = listed
    return found


async def choose() -> None:
    """Sets the model Plutus uses, unless a job is using one (then it changes when the job ends). Never raises: if
    Ollama can't be asked, the model stays as it was."""
    if settings.ollama_model or llm.busy:
        return
    try:
        if await llm.is_up():
            models = await llm.models()
            if models is None:  # the server didn't say: keep what we have
                return
        else:
            models = advice.models_on_disk()
        model = advice.model_in_use(advice.this_mac().memory_gb, models, preferences.ai_model())
    except Exception:  # noqa: BLE001 (a look at the status mustn't fail over this)
        log.exception("couldn't work out which local model to use")
        return
    if model != llm.model and not llm.busy:
        if model:
            log.info("local AI: using %s from now on%s", model, " (your choice)" if model == preferences.ai_model() else
                     " (the best one downloaded for this Mac)")
        llm.model = model


async def report() -> dict:
    """What the Local AI panel shows: this Mac, Ollama, the models downloaded and how each fits, what Plutus suggests,
    and the steps to get it."""
    await choose()
    a = advice.advise(advice.this_mac(), await _ollama(details=True), chosen=preferences.ai_model(),
                      override=settings.ollama_model)
    return {**advice.as_json(a), "hintSeen": preferences.ai_hint_seen()}


async def use(name: str | None) -> dict:
    """Use this downloaded model from now on; None: let Plutus pick the best one for this Mac again. Raises ValueError
    for a model that isn't downloaded or can't answer questions."""
    if name is not None:
        if not _NAME.match(name):
            raise ValueError("That isn't a model's name")
        found = await _ollama(details=True)
        if found.models is not None:
            model = next((m for m in found.models if m.name == name), None)
            if model is None:
                raise ValueError(f"{name} isn't downloaded. In Terminal: ollama pull {name}")
            if model.chat is False:
                raise ValueError(f"{name} can't answer questions: it only compares texts")
    preferences.set_ai_model(name)
    log.info("local AI: %s", f"you chose {name}" if name else "Plutus picks the best model downloaded for this Mac again")
    await choose()
    return await report()


async def summary() -> str:
    """One line for the log when Plutus starts."""
    a = advice.advise(advice.this_mac(), await _ollama(details=False), chosen=preferences.ai_model(),
                      override=settings.ollama_model)
    if a.ready:
        lighter = any(s.optional and s.command for s in a.steps) and a.suggestion
        return (f"{a.in_use} via Ollama{f' {a.ollama.version}' if a.ollama.version else ''}; wakes for a job, sleeps after "
                f"{int(llm.idle_seconds)}s idle" + (f". {a.suggestion.name} would suit this Mac better: see Local AI in "
                                                   "Plutus" if lighter else ""))
    suggest = f" For this Mac, Plutus suggests {a.suggestion.name}: the steps are under Local AI in Plutus." if a.suggestion else ""
    return f"{a.headline} (optional). Payees no rule knows wait for you in \"Needs your eyes\".{suggest}"
