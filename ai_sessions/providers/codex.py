from __future__ import annotations

import os
import shutil
import sys
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


def _codex_command() -> list[str]:
    """Resolve the `codex app-server` command, handling Windows .cmd shims."""
    override = os.environ.get("CODEX_BIN")
    if override:
        return [override, "app-server"]
    # On Windows, npm-installed `codex` is `codex.cmd`; subprocess won't auto-resolve.
    candidates = ["codex.cmd", "codex.exe", "codex"] if sys.platform == "win32" else ["codex"]
    for name in candidates:
        found = shutil.which(name)
        if found:
            return [found, "app-server"]
    return ["codex", "app-server"]


def _build_thread_config(yolo: bool, cwd: str | None) -> Any:
    """Build a ThreadConfig with YOLO and cwd applied. Returns None if no overrides."""
    from codex_app_server_sdk import ThreadConfig

    kwargs: dict[str, Any] = {}
    if cwd:
        kwargs["cwd"] = cwd
    if yolo:
        kwargs["sandbox"] = "danger-full-access"
        kwargs["approval_policy"] = "never"
    if not kwargs:
        return None
    return ThreadConfig(**kwargs)


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
        from codex_app_server_sdk import CodexClient

        is_yolo = yolo_default() if yolo is None else yolo
        config = _build_thread_config(is_yolo, cwd)

        async with CodexClient.connect_stdio(command=_codex_command()) as client:
            await client.initialize()
            if session_id:
                thread = await client.resume_thread(session_id, overrides=config)
            else:
                thread = await client.start_thread(config=config)
            result = await client.chat_once(prompt, thread_id=thread.thread_id)

        # ChatResult exposes assistant text + items; pick the most useful field.
        output = ""
        for attr in ("assistant_text", "final_response", "text"):
            v = getattr(result, attr, None)
            if v:
                output = v
                break
        return RunResult(
            sessionId=getattr(thread, "thread_id", None) or session_id,
            output=output,
            raw=result,
        )
