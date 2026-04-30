export interface SessionChannelBindings {
  telegram?: { chatId: number; threadId?: number };
}

// Background task launched by the agent during a route turn — captured so
// resume mode can poll the output file and re-enter the session when done.
export interface ResumeBgTask {
  // The Bash background task id ("bxxx") or Agent agentId ("agt_…").
  id: string;
  outputFile: string;
  // What kind of background tool emitted this — drives how we format the
  // re-entry prompt and how we recognize completion.
  kind: "bash" | "agent";
  // Optional human-friendly label for status display (the agent's own
  // description, or the first ~80 chars of the command).
  label?: string;
  launchedAt: string;
  // Set once the poller has fired its re-entry turn for this task; the
  // entry is then dropped from the pending list on the next persist.
  firedAt?: string;
}

export interface AiSession {
  id: string; // UUID
  name: string | null;
  provider: string; // "claude" | "codex" | "opencode"
  // Provider-side session id. Optional because an AiSession can be created
  // up-front (e.g. via the Telegram picker "+ new claude") and only filled
  // in once the first run completes on the provider.
  sessionId?: string;
  // Working directory the provider session was created under. Sticky:
  // resumes always use this cwd because providers (notably claude) scope
  // session storage by directory.
  cwd?: string;
  model?: string;
  // Reasoning effort for runs on this session — passed through to the
  // provider when supported (claude). Falls back to AI_SESSIONS_DEFAULT_EFFORT
  // (and ultimately "low") when unset.
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  channels?: SessionChannelBindings;
  // Mirror new entries from the provider session's transcript file into the
  // bound channel(s). Binary on/off — see /watch.
  watch?: boolean;
  watchStartedAt?: string;
  // Resume mode: when on, the server tracks background tasks the agent
  // launches during route turns (Bash run_in_background, Agent
  // run_in_background) and automatically fires a follow-up turn on the
  // same provider session when one finishes — so the agent picks up
  // where it left off without the user having to ping it. Sliding TTL
  // (resumeUntil) means it auto-stops after ~60min of silence.
  resume?: boolean;
  resumeStartedAt?: string;
  resumeUntil?: string;
  resumePendingTasks?: ResumeBgTask[];
  // Last assistant message we sent to the bound channel for this session,
  // regardless of source (routeToSession final reply OR session-watcher
  // forward). /watch status reads from this so users see the actual most
  // recent bot post, not just the last watcher-forwarded entry.
  lastBotMessageAt?: string;
  lastBotMessagePreview?: string;
  createdAt: string;
  updatedAt: string;
}
