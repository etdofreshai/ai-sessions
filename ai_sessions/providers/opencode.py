from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from ..config import yolo_default
from ..sessions import file_times, read_jsonl
from .base import RunResult, SessionDetail, SessionMessage, SessionSummary


def _opencode_home() -> Path:
    return Path(
        os.environ.get("OPENCODE_HOME")
        or (Path.home() / ".local" / "share" / "opencode")
    )


class OpencodeProvider:
    name = "opencode"

    async def is_available(self) -> bool:
        return _opencode_home().exists()

    async def list_sessions(self) -> list[SessionSummary]:
        root = _opencode_home()
        if not root.exists():
            return []
        out: list[SessionSummary] = []
        for pattern in ("**/session/**/*.json", "**/sessions/**/*.json", "**/*.jsonl"):
            for f in root.glob(pattern):
                t = file_times(f)
                out.append(
                    SessionSummary(
                        id=f.stem,
                        provider="opencode",
                        path=str(f),
                        createdAt=t["createdAt"],
                        updatedAt=t["updatedAt"],
                    )
                )
        out.sort(key=lambda s: s.updatedAt or "", reverse=True)
        return out

    async def get_session(self, id: str) -> SessionDetail:
        sessions = await self.list_sessions()
        match = next((s for s in sessions if s.id == id), None)
        if match is None:
            raise FileNotFoundError(f"opencode session not found: {id}")
        path = Path(match.path)
        messages: list[SessionMessage] = []
        if path.suffix == ".jsonl":
            for entry in read_jsonl(path):
                msg: Any = entry.get("message") or entry
                role = msg.get("role") if isinstance(msg, dict) else None
                content = msg.get("content") if isinstance(msg, dict) else None
                if not role:
                    continue
                content_str = (
                    content if isinstance(content, str) else json.dumps(content or "")
                )
                messages.append(
                    SessionMessage(
                        role=role,
                        content=content_str,
                        timestamp=entry.get("timestamp"),
                        raw=entry,
                    )
                )
        return SessionDetail(
            **match.__dict__,
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
        is_yolo = yolo_default() if yolo is None else yolo
        args = ["opencode", "run", prompt]
        if session_id:
            args += ["--session", session_id]
        if is_yolo:
            args.append("--yolo")
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                f"opencode exited {proc.returncode}: {stderr.decode(errors='replace')}"
            )
        return RunResult(sessionId=session_id, output=stdout.decode(errors="replace"))
