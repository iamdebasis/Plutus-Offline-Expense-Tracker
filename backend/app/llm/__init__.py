from app.config import settings
from app.llm.ollama import LLMUnavailable, OllamaManager

llm = OllamaManager(
    host=settings.ollama_host,
    model=settings.ollama_model,
    idle_seconds=settings.ollama_idle_seconds,
)

__all__ = ["llm", "LLMUnavailable", "OllamaManager"]
