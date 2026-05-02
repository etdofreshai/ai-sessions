# ai-sessions

Thin TypeScript CLI + local HTTP API to call, manage, and view sessions across `claude`, `codex`, and `opencode` — under one unified vocabulary.

## Vocabulary

- **Session** — a persistent conversation thread (Claude `session_id`, Codex `thread_id`, opencode session id).
- **Run** — a single prompt → response cycle inside a session. New runs can `--session <id>` to continue.
- **Event** — a streaming sub-step within a run: `session_id` · `text` · `tool_use` · `tool_result` · `error` · `end`.

## Install

```bash
npm install
npm run build
npm link   # exposes `ais` and `ai-sessions`
```

## CLI

```bash
ais providers                                  # detected providers
ais list <provider> [--limit N]                # sessions
ais view <provider> <session-id>               # transcript
ais run  <provider> "<prompt>" [--session ID]  # new run (or continue session)
                              [--cwd DIR] [--no-yolo] [--answer-only]

ais runs ls                                    # recent runs from dataDir/runs
ais runs show <run-id>                         # metadata + persisted events
ais runs interrupt <run-id>                    # stop a live run
ais runs steer <run-id> "<input>"              # inject mid-run user message (Claude)

ais serve [--port 7878]                        # local HTTP API
```

## Dashboard

Once `ais serve` is running, point a browser at <http://localhost:7878/ui> for a live console. Vanilla HTML/CSS/JS shell — no build step, just static files served by the same Express app. Views:

| View | What it shows |
|---|---|
| **Dashboard** | Rolling counts (created/completed/failed in last hour, hooks/min, longest-running) — backed by `GET /stats`. |
| **Subagents** | The supervisor task queue (`sub_agent_tasks`). Live table with summary cards + activity sparklines + a "+ new" modal for one-shot or plan-only creation. Drawer shows full row state, events log, response, and cancel/dispatch/delete actions. |
| **Sessions / Session** | Every `AiSession`. Detail page renders metadata + recent subagents + provider transcript. |
| **Hooks** | Tail of `hook_events`. Click a row → drawer with the full payload JSON. |
| **Usage** | Provider 5h / 7d / monthly bars. White tick is the linear time-target; eligibility ribbon mirrors the AFK rule (`usedPct ≤ target`). |
| **Crons / Jobs / Runs** | Scheduled wake-ups, long-running shell jobs, and recent provider runs. Click rows for details. |
| **Tree** | Layered SVG dependency graph for one supervisor's subagents. |
| **Timeline** | Gantt-style bars on a time axis with a live "now" marker. |
| **Logs** | Server stdout/stderr tail via SSE (`GET /logs/stream`) with `[subagents]`-only toggle. |
| **AFK** | Compose an `/afk` Telegram prompt with rotation preview (6 GLM / 3 Codex / 1 Claude review per 10 chunks); copy or post directly as a turn. |
| **Help** | Concepts, shortcuts, endpoint cheat-sheet. |

## HTTP API

```
GET  /
GET  /openapi.json                                 # OpenAPI 3.1
GET  /providers
GET  /providers/{provider}/sessions
GET  /providers/{provider}/sessions/{id}

POST /providers/{provider}/runs                    # SSE by default
                                                   # ?stream=0 → JSON RunMetadata
                                                   # ?answerOnly=1 → text/plain final answer
GET  /providers/{provider}/runs                    # recent run ids
GET  /providers/{provider}/runs/{runId}            # metadata + events (when terminal)
POST /providers/{provider}/runs/{runId}/interrupt
POST /providers/{provider}/runs/{runId}/steer      { input }   # 501 on codex/opencode

GET  /sessions                                     # AiSessions
GET  /sessions/{id}    PATCH    DELETE
POST /sessions/{id}/fork                           { targetProvider, destructive?, cwd? }

POST /subagents                                    # default: create + dispatch
                                                   # ?planOnly=1: create without launching
GET  /subagents                                    # ?aiSessionId=&status=&includeDeleted=1
GET  /subagents/runnable?aiSessionId=
GET  /subagents/{id}    PATCH    DELETE
POST /subagents/{id}/dispatch
POST /subagents/{id}/cancel       { reason? }
POST /subagents/{id}/complete     { response? }
POST /subagents/{id}/fail         { response? }
POST /subagents/{id}/merge-failed { response }
GET  /subagents/{id}/events
GET  /subagents/{id}/dependencies
POST /subagents/{id}/dependencies     { dependsOnTaskId }
DELETE /subagents/{id}/dependencies/{depId}

GET  /runs                                         # aggregate across providers
GET  /stats                                        # rolling counts for the dashboard
GET  /hooks                                        # ?session_id=&limit=
GET  /usage                                        # provider rate-limit windows
GET  /crons    POST    GET/{name}    PATCH    DELETE
GET  /jobs     POST    GET/{id}      POST/{id}/cancel
GET  /logs                                         # in-memory tail (4000-line ring)
GET  /logs/stream                                  # SSE: backfill + new lines
```

POST body for runs:
```json
{ "prompt": "...", "sessionId": "...", "cwd": "...", "yolo": true }
```

## Capabilities by provider

| Action | claude | codex | opencode |
|---|---|---|---|
| new session | ✓ | ✓ | ✓ |
| resume (`--session`) | ✓ | ✓ | ✓ |
| interrupt | ✓ (`Query.interrupt`) | ✓ (`turn/interrupt`) | ✓ (kill child) |
| steer | ✓ (streaming-input) | ✓ (`turn/steer`) | ✗ (501) |

Codex talks JSON-RPC NDJSON directly to `codex app-server` (not the npm SDK), which exposes `turn/steer` and `turn/interrupt`. Override the binary via `CODEX_BIN`.

## Config

`.env` is auto-loaded (Node `process.loadEnvFile()`).

| Var | Default | Notes |
|---|---|---|
| `AI_SESSIONS_YOLO` | `1` | `0` disables bypass-permissions / sandbox |
| `AI_SESSIONS_DATA_DIR` | `cwd` | Persistent state: `dataDir/runs/<id>.jsonl` |
| `AI_SESSIONS_PORT` | `7878` | Default port for `serve` |
| `CLAUDE_HOME` | `~/.claude` | |
| `CODEX_HOME` | `~/.codex` | |
| `OPENCODE_HOME` | `~/.local/share/opencode` | |
