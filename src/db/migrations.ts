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

  // 3. jobs — long-running work that lives outside any single agent turn.
  // The agent calls `ais jobs start <kind> ...`, gets a job_id back, and
  // its turn ends. The worker (running inside `ais serve`) picks the job
  // up, runs it for as long as needed (seconds to days), then injects the
  // result back into the originating AiSession as the next turn so the
  // agent picks up the work without the user having to ping it.
  // result_json holds the kind-specific result blob; status moves
  // pending → running → (succeeded|failed|cancelled).
  `
  CREATE TABLE jobs (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL,
    label         TEXT,
    ai_session_id TEXT,
    chat_id       INTEGER,
    pid           INTEGER,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT,
    result_json   TEXT,
    error         TEXT
  );
  CREATE INDEX jobs_status ON jobs(status, created_at);
  CREATE INDEX jobs_ai_session ON jobs(ai_session_id);
  `,

  // 4. sub_agents — parent ↔ child mapping for AiSessions spawned through
  // the outer harness. The outer harness creates the child AiSession and
  // tracks the relationship here so:
  //   - hooks from the child's provider session can resolve back to the
  //     parent's active-turn bubble (preview UX)
  //   - one-level-deep enforcement can refuse "agent X tries to spawn
  //     agent Y while X itself is a sub-agent"
  //   - /sub-agents ls --parent X works
  // The child's full state (provider, sessionId, cwd, etc.) lives in
  // ai_sessions; this table only holds the relationship + lifecycle.
  `
  CREATE TABLE sub_agents (
    id                    TEXT PRIMARY KEY,
    parent_ai_session_id  TEXT NOT NULL,
    child_ai_session_id   TEXT NOT NULL,
    provider              TEXT NOT NULL,
    provider_session_id   TEXT,
    provider_agent_id     TEXT,
    label                 TEXT,
    status                TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    result_summary        TEXT
  );
  CREATE INDEX sub_agents_parent ON sub_agents(parent_ai_session_id);
  CREATE INDEX sub_agents_child ON sub_agents(child_ai_session_id);
  CREATE INDEX sub_agents_provider_session ON sub_agents(provider_session_id);
  `,

  // 5. provider_defaults — per-provider settings that aren't tied to a
  // specific AiSession. First use case is the default reasoning effort
  // /effort default <level> writes; future entries (default cwd, default
  // model, etc.) can layer on the same row.
  `
  CREATE TABLE provider_defaults (
    provider       TEXT PRIMARY KEY,
    default_effort TEXT
  );
  `,

  // 6. app_settings — app-wide key/value store for runtime toggles that
  // aren't tied to a session, provider, or job. First use: the
  // skills.advertise_as_commands flag for /skills on|off.
  `
  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,

  // 7. sub_agents.last_activity_at — bumped on every event we observe from
  // the child run (session_id bind, hook PreToolUse/PostToolUse, image,
  // error). Lets the /subagents skill compute a stall heuristic without
  // having to crawl run_events.
  `
  ALTER TABLE sub_agents ADD COLUMN last_activity_at TEXT;
  `,

  // 8. sub_agent_tasks — supervisor-driven task queue for long-horizon
  // multi-agent plans. A supervisor AiSession creates tasks here; the
  // backend scheduler launches them when their dependencies complete,
  // links them to a real sub_agents row when dispatched, and marks them
  // stale/failed if they go silent past timeout_seconds. Worktree
  // metadata lives directly on the task (no separate table). Events are
  // append-only for debugging/history. See plan in commit message.
  `
  CREATE TABLE sub_agent_tasks (
    id                    TEXT PRIMARY KEY,
    ai_session_id         TEXT NOT NULL,
    title                 TEXT NOT NULL,
    prompt                TEXT NOT NULL,
    response              TEXT,
    status                TEXT NOT NULL DEFAULT 'created',
    provider              TEXT,
    provider_session_id   TEXT,
    sub_agent_id          TEXT,
    effort                TEXT,
    cwd                   TEXT,
    base_ref              TEXT,
    branch_name           TEXT,
    worktree_path         TEXT,
    merge_strategy        TEXT NOT NULL DEFAULT 'auto',
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    max_attempts          INTEGER NOT NULL DEFAULT 2,
    timeout_seconds       INTEGER NOT NULL DEFAULT 1200,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    deleted_at            TEXT
  );
  CREATE INDEX sub_agent_tasks_ai_session ON sub_agent_tasks(ai_session_id);
  CREATE INDEX sub_agent_tasks_status ON sub_agent_tasks(status);
  CREATE INDEX sub_agent_tasks_scheduler ON sub_agent_tasks(ai_session_id, status, created_at);
  CREATE INDEX sub_agent_tasks_provider_session ON sub_agent_tasks(provider_session_id);
  CREATE INDEX sub_agent_tasks_sub_agent ON sub_agent_tasks(sub_agent_id);

  CREATE TABLE sub_agent_task_dependencies (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL,
    depends_on_task_id  TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    UNIQUE(task_id, depends_on_task_id),
    FOREIGN KEY (task_id) REFERENCES sub_agent_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES sub_agent_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX sub_agent_task_dependencies_task ON sub_agent_task_dependencies(task_id);
  CREATE INDEX sub_agent_task_dependencies_depends_on ON sub_agent_task_dependencies(depends_on_task_id);

  CREATE TABLE sub_agent_task_events (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    message     TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES sub_agent_tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX sub_agent_task_events_task ON sub_agent_task_events(task_id, created_at);
  `,

  // 9. sub_agent_tasks.notify_supervisor — when 0, the runner finishes
  // the subagent normally (status mirrors, response stored, events
  // logged) but skips injectTurnOnSession on the parent. Use case:
  // long-running fire-and-forget work where the supervisor wants to
  // poll /subagents later instead of being woken on completion.
  `
  ALTER TABLE sub_agent_tasks ADD COLUMN notify_supervisor INTEGER NOT NULL DEFAULT 1;
  `,

  // 10. sub_agent_tasks.activity_count — bumped on every touchActivity.
  // Cheap "is this thing actually doing anything?" signal that the
  // /subagents Telegram view surfaces alongside updated_at so a user
  // glancing at the list can tell movement from stalled at a glance.
  `
  ALTER TABLE sub_agent_tasks ADD COLUMN activity_count INTEGER NOT NULL DEFAULT 0;
  `,
];
