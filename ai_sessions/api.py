from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import __version__
from .config import data_dir, yolo_default
from .providers import PROVIDERS, get_provider, list_provider_names


class RunBody(BaseModel):
    prompt: str
    sessionId: str | None = None
    cwd: str | None = None
    yolo: bool | None = None


def create_app() -> FastAPI:
    app = FastAPI(
        title="ai-sessions API",
        version=__version__,
        description=(
            "Local API to call, manage, and view sessions across claude, codex, "
            "and opencode. YOLO (bypass permissions/sandbox) is on by default; "
            "disable with AI_SESSIONS_YOLO=0 or per-request `yolo: false`."
        ),
    )

    @app.get("/")
    async def index() -> dict[str, Any]:
        return {
            "name": "ai-sessions",
            "version": __version__,
            "yoloDefault": yolo_default(),
            "dataDir": str(data_dir()),
            "docs": "/docs",
            "openapi": "/openapi.json",
        }

    @app.get("/providers")
    async def providers_list() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for name in list_provider_names():
            out.append(
                {"name": name, "available": await PROVIDERS[name].is_available()}
            )
        return out

    @app.get("/providers/{provider}/sessions")
    async def list_sessions(provider: str) -> list[dict[str, Any]]:
        try:
            sessions = await get_provider(provider).list_sessions()
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return [asdict(s) for s in sessions]

    @app.get("/providers/{provider}/sessions/{session_id}")
    async def get_session(provider: str, session_id: str) -> dict[str, Any]:
        try:
            detail = await get_provider(provider).get_session(session_id)
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except FileNotFoundError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return asdict(detail)

    @app.post("/providers/{provider}/run")
    async def run_prompt(provider: str, body: RunBody) -> dict[str, Any]:
        try:
            result = await get_provider(provider).run(
                body.prompt,
                session_id=body.sessionId,
                cwd=body.cwd,
                yolo=body.yolo,
            )
        except KeyError as e:
            raise HTTPException(status_code=404, detail=str(e))
        return asdict(result)

    return app


app = create_app()
