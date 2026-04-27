# ai-sessions

Thin TypeScript CLI + local HTTP API to call, manage, and view sessions across `claude`, `codex`, and `opencode`.

Inspired by [`etdofreshai/claude-code-server`](https://github.com/etdofreshai/claude-code-server).

## Install

```bash
npm install
npm run build
npm link   # exposes `ai-sessions` and `ais`
```

## CLI

```bash
ais providers                       # list available providers
ais list <provider>                 # list sessions for a provider
ais view <provider> <session-id>    # print a session transcript
ais run  <provider> "<prompt>"      # start a new session
ais resume <provider> <session-id>  # continue an existing session (where supported)
ais serve [--port 7878]             # start local HTTP API
```

Providers: `claude`, `codex`, `opencode`.

## HTTP API

```
GET  /providers
GET  /providers/:provider/sessions
GET  /providers/:provider/sessions/:id
POST /providers/:provider/run        { prompt, sessionId? }
```

## How it works

- **claude / codex**: uses the official SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`) to run prompts; reads on-disk session JSONL for list/view.
- **opencode**: shells out to the `opencode` binary; reads on-disk storage for list/view.

Session storage paths (auto-detected, override with env vars):

| Provider | Default path | Override |
|---|---|---|
| claude   | `~/.claude/projects/**/*.jsonl` | `CLAUDE_HOME` |
| codex    | `~/.codex/sessions/**/*.jsonl`  | `CODEX_HOME` |
| opencode | `~/.local/share/opencode/**`    | `OPENCODE_HOME` |
