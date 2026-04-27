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
