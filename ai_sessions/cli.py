from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Optional

import typer
import uvicorn

from . import __version__
from .config import port as default_port
from .providers import PROVIDERS, get_provider, list_provider_names

app = typer.Typer(
    add_completion=False,
    help="Thin CLI to call, manage, and view sessions across claude, codex, and opencode",
)


@app.command()
def providers() -> None:
    """List available providers."""

    async def _go() -> None:
        for name in list_provider_names():
            ok = await PROVIDERS[name].is_available()
            typer.echo(f"{'[x]' if ok else '[ ]'} {name}")

    asyncio.run(_go())


@app.command("list")
def list_cmd(
    provider: str,
    limit: Optional[int] = typer.Option(None, "--limit", "-l"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """List sessions for a provider."""

    async def _go() -> None:
        sessions = await get_provider(provider).list_sessions()
        if limit:
            sessions_used = sessions[:limit]
        else:
            sessions_used = sessions
        if json_out:
            typer.echo(json.dumps([asdict(s) for s in sessions_used], indent=2))
            return
        for s in sessions_used:
            typer.echo(f"{s.updatedAt or '-'}  {s.id}  {s.cwd or ''}")

    asyncio.run(_go())


@app.command()
def view(
    provider: str,
    id: str,
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """View a session's transcript."""

    async def _go() -> None:
        detail = await get_provider(provider).get_session(id)
        if json_out:
            typer.echo(json.dumps(asdict(detail), indent=2))
            return
        typer.echo(f"# {provider}:{id}  ({detail.messageCount} messages)")
        if detail.cwd:
            typer.echo(f"cwd: {detail.cwd}")
        typer.echo("")
        for m in detail.messages:
            ts = f"  {m.timestamp}" if m.timestamp else ""
            typer.echo(f"--- {m.role}{ts} ---")
            typer.echo(m.content)
            typer.echo("")

    asyncio.run(_go())


@app.command()
def run(
    provider: str,
    prompt: str,
    cwd: Optional[str] = typer.Option(None, "--cwd", "-c"),
    yolo: bool = typer.Option(True, "--yolo/--no-yolo"),
) -> None:
    """Run a new prompt in a fresh session."""

    async def _go() -> None:
        result = await get_provider(provider).run(
            prompt, cwd=cwd, yolo=yolo
        )
        typer.echo(result.output)
        if result.sessionId:
            typer.echo(f"session: {result.sessionId}", err=True)

    asyncio.run(_go())


@app.command()
def resume(
    provider: str,
    id: str,
    prompt: str,
    cwd: Optional[str] = typer.Option(None, "--cwd", "-c"),
    yolo: bool = typer.Option(True, "--yolo/--no-yolo"),
) -> None:
    """Resume an existing session with a new prompt."""

    async def _go() -> None:
        result = await get_provider(provider).run(
            prompt, session_id=id, cwd=cwd, yolo=yolo
        )
        typer.echo(result.output)
        if result.sessionId:
            typer.echo(f"session: {result.sessionId}", err=True)

    asyncio.run(_go())


@app.command()
def serve(
    port: int = typer.Option(default_port(), "--port", "-p"),
    host: str = typer.Option("127.0.0.1", "--host"),
) -> None:
    """Start the local FastAPI HTTP server."""
    uvicorn.run("ai_sessions.api:app", host=host, port=port, log_level="info")


@app.command()
def version() -> None:
    """Print the package version."""
    typer.echo(__version__)


if __name__ == "__main__":
    app()
