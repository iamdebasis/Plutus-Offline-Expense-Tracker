"""python -m app.llm [--prompt]: start Ollama on demand, optionally ask one question, then stop it."""

import asyncio
import json
import sys
import time
from importlib import resources

from app import logs
from app.llm import llm, setup

logs.setup()


def _category_ids() -> list[str]:
    tree = json.loads(resources.files("app.seed").joinpath("categories.json").read_text(encoding="utf-8"))
    return [c["id"] for top in tree for c in [top, *top.get("children", [])]]


async def main(with_prompt: bool) -> None:
    await setup.choose()
    print(f"binary        : {llm.binary()}")
    print(f"model         : {llm.model or 'none set up: ' + await setup.summary()}")
    if not llm.model:
        return
    print(f"already up    : {await llm.is_up()}")
    started = time.monotonic()
    async with llm.session() as ai:
        print(f"ready in      : {time.monotonic() - started:.1f}s (started by this app: {ai.owns_server})")
        if with_prompt:
            schema = {
                "type": "object",
                "properties": {"merchant": {"type": "string"}, "category": {"type": "string", "enum": _category_ids()}},
                "required": ["merchant", "category"],
            }
            # well-known names the model should place, and one it shouldn't take for a shop
            for raw in ["PYU*SWIGGY", "APOLLO PHARMACY", "INDIAN OIL FUEL STATION", "MR FAKE PERSON"]:
                t = time.monotonic()
                out = await ai.chat(
                    [{"role": "user", "content": f"Indian card/UPI transaction description: {raw!r}. "
                                                 "Name the merchant and pick the best spending category."}],
                    schema=schema,
                )
                print(f"  {raw:<28} -> {out}  ({time.monotonic() - t:.1f}s)")
    await llm.shutdown()
    print(f"up after stop : {await llm.is_up()}")


if __name__ == "__main__":
    asyncio.run(main(with_prompt="--prompt" in sys.argv))
