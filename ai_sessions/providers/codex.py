from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

from ..config import yolo_default
from ..sessions import file_times, read_jsonl
from .base import RunResult, SessionDetail, SessionMessage, SessionSummary


def _codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))


def _sessions_dir() -> Path:
    return _codex_home() / "sessions"


def _derive_id(path: Path) -> str:
    base = path.stem
    idx = base.rfind("-")
    return base[idx + 1 :] if idx > 0 else base


def _flatten(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out: list[str] = []
        for c in content:
            if isinstance(c, dict):
                out.append(c.get("text") or str(c))
            else:
                out.append(str(c))
        return "\n".join(out)
    return "" if content is None else str(content)


class CodexProvider:
    name = "codex"

    async def is_available(self) -> bool:
        return _sessions_dir().exists()

    async def list_sessions(self) -> list[SessionSummary]:
        root = _sessions_dir()
        if not root.exists():
            return []
        out: list[SessionSummary] = []
        for f in root.rglob("*.jsonl"):
            t = file_times(f)
            out.append(
                SessionSummary(
                    id=_derive_id(f),
                    provider="codex",
                    path=str(f),
                    createdAt=t["createdAt"],
                    updatedAt=t["updatedAt"],
                )
            )
        out.sort(key=lambda s: s.updatedAt or "", reverse=True)
        return out

    async def get_session(self, id: str) -> SessionDetail:
        root = _sessions_dir()
        match: Path | None = None
        for f in root.rglob("*.jsonl"):
            if _derive_id(f) == id or f.stem == id:
                match = f
                break
        if match is None:
            raise FileNotFoundError(f"codex session not found: {id}")
        messages: list[SessionMessage] = []
        for entry in read_jsonl(match):
            payload = entry.get("payload") or {}
            role = entry.get("role") or payload.get("role")
            content = entry.get("content") or payload.get("content")
            if not role or content is None:
                continue
            messages.append(
                SessionMessage(
                    role=role,
                    content=_flatten(content),
                    timestamp=entry.get("timestamp"),
                    raw=entry,
                )
            )
        t = file_times(match)
        return SessionDetail(
            id=id,
            provider="codex",
            path=str(match),
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
        # NOTE: package import path is the working assumption from openai/codex
        # sdk/python; verify after `pip install` and adjust if needed.
        from codex_app_server import Codex, TextInput  # type: ignore

        is_yolo = yolo_default() if yolo is None else yolo

        thread_kwargs: dict[str, Any] = {}
        if cwd:
            thread_kwargs["cwd"] = cwd
        if is_yolo:
            thread_kwargs["sandbox_policy"] = {
                "type": "danger-full-access",
            }
            thread_kwargs["approval_policy"] = "never"
            thread_kwargs["skip_git_repo_check"] = True

        def _run() -> RunResult:
            with Codex() as codex:
                if session_id:
                    thread = codex.thread_resume(session_id, **thread_kwargs)
                else:
                    thread = codex.thread_start(**thread_kwargs)
                turn = thread.turn(TextInput(prompt))
                result = turn.run()
                final_text = ""
                # Best-effort extraction; codex Turn shape varies by version.
                items = getattr(result, "items", None) or getattr(turn, "items", [])
                for item in items:
                    text = getattr(item, "text", None)
                    if text:
                        final_text += text + "\n"
                if not final_text:
                    final_text = str(getattr(result, "final_response", "") or "")
                tid = getattr(thread, "id", None) or session_id
                return RunResult(sessionId=tid, output=final_text.strip(), raw=result)

        return await asyncio.to_thread(_run)
