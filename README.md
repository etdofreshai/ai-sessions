# ai-sessions

Thin Python CLI + FastAPI HTTP API to call, manage, and view sessions across `claude`, `codex`, and `opencode`.

Why Python: the Codex Python SDK exposes `turn.steer()` and `turn.interrupt()` (the TS SDK does not), so going Python unlocks full feature parity with the underlying agents.

## Install

Requires **Python 3.12+** (the Codex SDK `codex-app-server-sdk` needs it).

```bash
python3.12 -m venv .venv && . .venv/bin/activate    # or .venv\Scripts\activate on Windows
pip install -e .
```

## CLI

```bash
ais providers                     # which providers are detected
ais list <provider> [--limit N]   # list sessions
ais view <provider> <id>          # print transcript
ais run  <provider> "<prompt>"    # new session
ais resume <provider> <id> "..."  # continue an existing session
ais serve [--port 7878]           # start the HTTP API
```

Providers: `claude`, `codex`, `opencode`. YOLO (bypass permissions/sandbox) is on by default — disable per-call with `--no-yolo` or globally via `AI_SESSIONS_YOLO=0`.

## HTTP API

FastAPI auto-generates docs:
- `GET /openapi.json` — OpenAPI 3.1
- `GET /docs` — Swagger UI
- `GET /redoc` — ReDoc

Routes (v0):
```
GET  /
GET  /providers
GET  /providers/{provider}/sessions
GET  /providers/{provider}/sessions/{id}
POST /providers/{provider}/run        { prompt, sessionId?, cwd?, yolo? }
```

Provider-specific SDK-mirror routes (steer/interrupt) coming next.

## Config

Loaded from `.env` automatically.

| Var | Default | Notes |
|---|---|---|
| `AI_SESSIONS_YOLO` | `1` | `0` disables bypass-permissions / sandbox |
| `AI_SESSIONS_DATA_DIR` | `cwd` | Persistent state dir (use `/app/data` in Docker) |
| `AI_SESSIONS_PORT` | `7878` | Default port for `serve` |
| `CLAUDE_HOME` | `~/.claude` | Override Claude session storage path |
| `CODEX_HOME` | `~/.codex` | Override Codex session storage path |
| `OPENCODE_HOME` | `~/.local/share/opencode` | Override opencode storage path |
