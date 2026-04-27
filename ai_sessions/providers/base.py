from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class SessionSummary:
    id: str
    provider: str
    path: str
    cwd: str | None = None
    title: str | None = None
    createdAt: str | None = None
    updatedAt: str | None = None
    messageCount: int | None = None


@dataclass
class SessionMessage:
    role: str
    content: str
    timestamp: str | None = None
    raw: Any = None


@dataclass
class SessionDetail(SessionSummary):
    messages: list[SessionMessage] = field(default_factory=list)


@dataclass
class RunResult:
    sessionId: str | None
    output: str
    raw: Any = None


class Provider(Protocol):
    name: str

    async def is_available(self) -> bool: ...

    async def list_sessions(self) -> list[SessionSummary]: ...

    async def get_session(self, id: str) -> SessionDetail: ...

    async def run(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        yolo: bool | None = None,
    ) -> RunResult: ...
