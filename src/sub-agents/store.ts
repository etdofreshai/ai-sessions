import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { SubAgent, SubAgentStatus } from "./types.js";

interface Row {
  id: string;
  parent_ai_session_id: string;
  child_ai_session_id: string;
  provider: string;
  provider_session_id: string | null;
  provider_agent_id: string | null;
  label: string | null;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
}

function fromRow(r: Row): SubAgent {
  return {
    id: r.id,
    parentAiSessionId: r.parent_ai_session_id,
    childAiSessionId: r.child_ai_session_id,
    provider: r.provider,
    providerSessionId: r.provider_session_id ?? undefined,
    providerAgentId: r.provider_agent_id ?? undefined,
    label: r.label ?? undefined,
    status: r.status as SubAgentStatus,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    resultSummary: r.result_summary ?? undefined,
  };
}

export function newSubAgentId(): string {
  return randomUUID();
}

export function create(args: {
  parentAiSessionId: string;
  childAiSessionId: string;
  provider: string;
  label?: string;
}): SubAgent {
  const id = newSubAgentId();
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO sub_agents
       (id, parent_ai_session_id, child_ai_session_id, provider, label, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    args.parentAiSessionId,
    args.childAiSessionId,
    args.provider,
    args.label ?? null,
    now,
  );
  return read(id)!;
}

export function read(id: string): SubAgent | null {
  const row = db().prepare(`SELECT * FROM sub_agents WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listByParent(parentAiSessionId: string): SubAgent[] {
  const rows = db().prepare(
    `SELECT * FROM sub_agents WHERE parent_ai_session_id = ? ORDER BY created_at DESC`,
  ).all(parentAiSessionId) as Row[];
  return rows.map(fromRow);
}

// Reverse lookup used by hook dispatch: a hook arrives keyed by the inner
// harness session_id; if it matches a child here, the dispatcher can route
// the event to the parent's preview bubble.
export function findByChildProviderSession(
  providerSessionId: string,
): SubAgent | null {
  const row = db().prepare(
    `SELECT * FROM sub_agents WHERE provider_session_id = ? LIMIT 1`,
  ).get(providerSessionId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function findByChildAiSession(
  childAiSessionId: string,
): SubAgent | null {
  const row = db().prepare(
    `SELECT * FROM sub_agents WHERE child_ai_session_id = ? LIMIT 1`,
  ).get(childAiSessionId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function bindProviderSession(id: string, providerSessionId: string): void {
  db().prepare(
    `UPDATE sub_agents SET provider_session_id = ? WHERE id = ?`,
  ).run(providerSessionId, id);
}

export function setStatus(id: string, status: SubAgentStatus): void {
  const now = new Date().toISOString();
  // Stamp lifecycle timestamps as we move through states.
  if (status === "running") {
    db().prepare(
      `UPDATE sub_agents SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
    ).run(status, now, id);
  } else if (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  ) {
    db().prepare(
      `UPDATE sub_agents SET status = ?, finished_at = ? WHERE id = ?`,
    ).run(status, now, id);
  } else {
    db().prepare(`UPDATE sub_agents SET status = ? WHERE id = ?`).run(status, id);
  }
}

export function setResultSummary(id: string, summary: string): void {
  db().prepare(`UPDATE sub_agents SET result_summary = ? WHERE id = ?`).run(
    summary.slice(0, 240),
    id,
  );
}

// True when the given AiSession is a child of some other AiSession — used
// to enforce one-level-deep before allowing it to spawn its own sub-agents.
export function isChild(aiSessionId: string): boolean {
  const row = db().prepare(
    `SELECT 1 FROM sub_agents WHERE child_ai_session_id = ? LIMIT 1`,
  ).get(aiSessionId);
  return !!row;
}

export function listOutstandingForParent(parentAiSessionId: string): SubAgent[] {
  const rows = db().prepare(
    `SELECT * FROM sub_agents
     WHERE parent_ai_session_id = ? AND status IN ('pending', 'running')
     ORDER BY created_at ASC`,
  ).all(parentAiSessionId) as Row[];
  return rows.map(fromRow);
}
