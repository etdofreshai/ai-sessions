# Hook ingest

ai-sessions accepts hook callbacks from inner harnesses (Claude Code, Codex)
at `POST /hooks/claude` and `POST /hooks/codex`. Each event is persisted to
the `hook_events` table for inspection and the endpoint always responds with
`{"continue": true}` for now. Acting on events (blocking tool calls,
forwarding to Telegram, capturing bg-task launches) layers on top — see the
architecture doc.

To opt in, point the harness at our endpoint.

## Claude Code (`~/.claude/settings.json`)

Each hook entry just shells `curl` against our endpoint with the event JSON
on stdin. Matcher `".*"` catches every tool; tighten if you only care about
specific ones.

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "PreToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "PostToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/claude -H 'content-type: application/json' --data-binary @-" }] }
    ]
  }
}
```

`--max-time 5` keeps a stalled ai-sessions from blocking the harness — at the
cost of dropping a hook event if our server is down longer than that. The
harness still keeps running because we degrade open.

## Codex (`~/.codex/config.toml`)

Codex doesn't ship hooks natively; install
[hatayama/codex-hooks](https://github.com/hatayama/codex-hooks) which adds a
Claude-compatible hooks layer. Once installed, the same JSON wiring above
loads from `~/.codex/codex-hooks.json` (or wherever the plugin reads from).
If you'd rather hand-edit `config.toml`, the canonical Codex hook block is:

```toml
[[hooks.PostToolUse]]
matcher = ".*"
command = "curl -fsS --max-time 5 -X POST http://localhost:7878/hooks/codex -H 'content-type: application/json' --data-binary @-"
```

…repeated per event you care about.

## Verifying

After wiring, drive a turn through the harness and:

```
curl -s http://localhost:7878/hooks | jq '.[0]'
```

You should see the most-recent event with `harness`, `event_name`,
`session_id`, `tool_name`, and the full `payload`.
