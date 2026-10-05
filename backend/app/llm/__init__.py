from app.config import settings
from app.llm.ollama import LLMUnavailable, OllamaManager


async def _choose() -> None:
    from app.llm import setup  # here, not at import: it reads your settings

    await setup.choose()


llm = OllamaManager(
    host=settings.ollama_host,
    model=settings.ollama_model,
    idle_seconds=settings.ollama_idle_seconds,
    choose=None if settings.ollama_model else _choose,
)

__all__ = ["llm", "LLMUnavailable", "OllamaManager"]
