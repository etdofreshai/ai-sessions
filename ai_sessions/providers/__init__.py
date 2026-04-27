from __future__ import annotations

from .base import Provider
from .claude import ClaudeProvider
from .codex import CodexProvider
from .opencode import OpencodeProvider

PROVIDERS: dict[str, Provider] = {
    "claude": ClaudeProvider(),
    "codex": CodexProvider(),
    "opencode": OpencodeProvider(),
}


def get_provider(name: str) -> Provider:
    if name not in PROVIDERS:
        raise KeyError(
            f"unknown provider: {name} (expected: {', '.join(PROVIDERS.keys())})"
        )
    return PROVIDERS[name]


def list_provider_names() -> list[str]:
    return list(PROVIDERS.keys())
