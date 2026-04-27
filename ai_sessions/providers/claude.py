from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..config import yolo_default
from ..sessions import file_times, read_jsonl
from .base import RunResult, SessionDetail, SessionMessage, SessionSummary


def _claude_home() -> Path:
    return Path(os.environ.get("CLAUDE_HOME") or (Path.home() / ".claude"))


def _projects_dir() -> Path:
    return _claude_home() / "projects"


def _flatten(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out: list[str] = []
        for c in content:
            if isinstance(c, str):
                out.append(c)
            elif isinstance(c, dict):
                out.append(c.get("text") or str(c))
            else:
                out.append(str(c))
        return "\n".join(out)
    return "" if content is None else str(content)


class ClaudeProvider:
    name = "claude"

    async def is_available(self) -> bool:
        return _projects_dir().exists()

    async def list_sessions(self) -> list[SessionSummary]:
        root = _projects_dir()
        if not root.exists():
            return []
        out: list[SessionSummary] = []
        for f in root.rglob("*.jsonl"):
            t = file_times(f)
            out.append(
                SessionSummary(
                    id=f.stem,
                    provider="claude",
                    path=str(f),
                    createdAt=t["createdAt"],
                    updatedAt=t["updatedAt"],
                )
            )
        out.sort(key=lambda s: s.updatedAt or "", reverse=True)
        return out

    async def get_session(self, id: str) -> SessionDetail:
        root = _projects_dir()
        match = next(root.rglob(f"{id}.jsonl"), None)
        if match is None:
            raise FileNotFoundError(f"claude session not found: {id}")
        messages: list[SessionMessage] = []
        cwd: str | None = None
        for entry in read_jsonl(match):
            if not cwd and entry.get("cwd"):
                cwd = entry["cwd"]
            msg = entry.get("message") or {}
            role = msg.get("role")
            if not role:
                continue
            messages.append(
                SessionMessage(
                    role=role,
                    content=_flatten(msg.get("content")),
                    timestamp=entry.get("timestamp"),
                    raw=entry,
                )
            )
        t = file_times(match)
        return SessionDetail(
            id=id,
            provider="claude",
            path=str(match),
            cwd=cwd,
            messageCount=len(messages),
            createdAt=t["createdAt"],
            updatedAt=t["updatedAt"],
            messages=messages,
        )

    async def run(
        self,
        prompt: str,
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        yolo: bool | None = None,
    ) -> RunResult:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeAgentOptions,
            ResultMessage,
            TextBlock,
            query,
        )

        is_yolo = yolo_default() if yolo is None else yolo
        opts_kwargs: dict[str, Any] = {}
        if cwd:
            opts_kwargs["cwd"] = cwd
        if session_id:
            opts_kwargs["resume"] = session_id
        if is_yolo:
            opts_kwargs["permission_mode"] = "bypassPermissions"

        options = ClaudeAgentOptions(**opts_kwargs)

        chunks: list[str] = []
        sid: str | None = session_id
        async for msg in query(prompt=prompt, options=options):
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
            elif isinstance(msg, ResultMessage):
                sid = getattr(msg, "session_id", sid) or sid

        return RunResult(sessionId=sid, output="\n".join(chunks))
