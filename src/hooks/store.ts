import { db } from "../db/index.js";
import * as aiStore from "../ai-sessions/store.js";

export interface HookEventRecord {
  id: number;
  receivedAt: string;
  harness: "claude" | "codex";
  eventName: string;
  sessionId?: string;
  aiSessionId?: string;
  toolName?: string;
  payload: Record<string, unknown>;
}

interface Row {
  id: number;
  received_at: string;
  harness: string;
  event_name: string;
  session_id: string | null;
  ai_session_id: string | null;
  tool_name: string | null;
  payload_json: string;
}

function fromRow(r: Row): HookEventRecord {
  return {
    id: r.id,
    receivedAt: r.received_at,
    harness: r.harness as "claude" | "codex",
    eventName: r.event_name,
    sessionId: r.session_id ?? undefined,
    aiSessionId: r.ai_session_id ?? undefined,
    toolName: r.tool_name ?? undefined,
    payload: JSON.parse(r.payload_json),
  };
}

// Persist a hook payload. `harness` selects the event-name + session-id key
// extraction since Claude and Codex differ slightly in field naming.
export function record(args: {
  harness: "claude" | "codex";
  payload: Record<string, unknown>;
}): HookEventRecord {
  const { harness, payload } = args;
  const eventName =
    (payload.hook_event_name as string | undefined) ??
    (payload.event_name as string | undefined) ??
    "unknown";
  const sessionId = (payload.session_id as string | undefined) ?? undefined;
  const toolName = (payload.tool_name as string | undefined) ?? undefined;
  // Resolve to one of our AiSessions if we recognize the inner session_id.
  // Best-effort — None means "no current binding," which is fine for
  // SessionStart events that arrive before the AiSession is finalized.
  const aiSessionId = sessionId
    ? aiStore.findByProviderSession(harness, sessionId)?.id
    : undefined;
  const receivedAt = new Date().toISOString();
  const info = db().prepare(
    `INSERT INTO hook_events
       (received_at, harness, event_name, session_id, ai_session_id, tool_name, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receivedAt,
    harness,
    eventName,
    sessionId ?? null,
    aiSessionId ?? null,
    toolName ?? null,
    JSON.stringify(payload),
  );
  return {
    id: Number(info.lastInsertRowid),
    receivedAt,
    harness,
    eventName,
    sessionId,
    aiSessionId,
    toolName,
    payload,
  };
}

// Recent events for a given inner harness session, oldest first.
export function listForSession(
  sessionId: string,
  limit = 200,
): HookEventRecord[] {
  const rows = db().prepare(
    `SELECT * FROM hook_events
     WHERE session_id = ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(sessionId, limit) as Row[];
  return rows.map(fromRow);
}

// Recent events across all sessions, newest first — for a console/debug view.
export function listRecent(limit = 200): HookEventRecord[] {
  const rows = db().prepare(
    `SELECT * FROM hook_events ORDER BY id DESC LIMIT ?`,
  ).all(limit) as Row[];
  return rows.map(fromRow);
}
