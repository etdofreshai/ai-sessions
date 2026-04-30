// Schema migrations applied in order, each indexed at user_version = i+1.
// Add new entries to the end — never edit a published migration; write a
// new ALTER TABLE migration instead so deployed installs upgrade cleanly.
//
// Stores that hold blob-shaped state we don't query inside SQL (channels,
// resumePendingTasks, run events) get a single TEXT/JSON column rather
// than a normalized schema — keeps the migrations short and matches how
// the JSON stores worked before. Indexed columns are the ones the app
// actually filters on (ai_sessions.session_id for findByProviderSession,
// crons.next_run_at for the scheduler, etc.).
export const migrations: string[] = [
  // 1. ai_sessions, crons, usage, runs, run_events.
  `
  CREATE TABLE ai_sessions (
    id              TEXT PRIMARY KEY,
    name            TEXT,
    provider        TEXT NOT NULL,
    session_id      TEXT,
    cwd             TEXT,
    model           TEXT,
    reasoning_effort TEXT,
    channels_json   TEXT,
    watch           INTEGER,
    watch_started_at TEXT,
    resume          INTEGER,
    resume_started_at TEXT,
    resume_until    TEXT,
    resume_pending_tasks_json TEXT,
    last_bot_message_at TEXT,
    last_bot_message_preview TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX ai_sessions_provider_session ON ai_sessions(provider, session_id);
  CREATE INDEX ai_sessions_updated_at ON ai_sessions(updated_at DESC);

  CREATE TABLE crons (
    name              TEXT PRIMARY KEY,
    cron              TEXT NOT NULL,
    timezone          TEXT,
    target_json       TEXT NOT NULL,
    enabled           INTEGER NOT NULL,
    missed_policy     TEXT NOT NULL,
    next_run_at       TEXT NOT NULL,
    last_run_at       TEXT,
    last_started_at   TEXT,
    last_error        TEXT,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX crons_next_run_at ON crons(next_run_at);

  CREATE TABLE usage_snapshots (
    provider     TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    observed_at  TEXT NOT NULL
  );

  CREATE TABLE runs (
    run_id          TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    session_id      TEXT,
    ai_session_id   TEXT,
    status          TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    cwd             TEXT,
    yolo            INTEGER NOT NULL,
    internal        INTEGER,
    created_at      TEXT NOT NULL,
    ended_at        TEXT,
    output          TEXT,
    error           TEXT
  );
  CREATE INDEX runs_created_at ON runs(created_at DESC);
  CREATE INDEX runs_ai_session_id ON runs(ai_session_id);

  CREATE TABLE run_events (
    run_id  TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    type    TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (run_id, seq),
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  );
  `,

  // 2. hook_events — append-only log of every hook callback received from
  // an inner harness (Claude Code / Codex). Indexed by harness session_id
  // so we can read all events for a turn back without scanning the table.
  // payload_json is the entire body the harness sent us; we don't normalize
  // per-event fields because the schema differs by event_name and we want
  // to be able to add new event types without migrations.
  `
  CREATE TABLE hook_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at   TEXT NOT NULL,
    harness       TEXT NOT NULL,        -- 'claude' | 'codex'
    event_name    TEXT NOT NULL,        -- PreToolUse, PostToolUse, Stop, ...
    session_id    TEXT,                 -- inner harness session id
    ai_session_id TEXT,                 -- our wrapper, if resolvable
    tool_name     TEXT,                 -- handy for filtering tool events
    payload_json  TEXT NOT NULL
  );
  CREATE INDEX hook_events_session ON hook_events(session_id, received_at);
  CREATE INDEX hook_events_received ON hook_events(received_at DESC);
  `,
];
