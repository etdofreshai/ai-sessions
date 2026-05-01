import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Job, JobPayload, JobResult, JobStatus } from "./types.js";

interface Row {
  id: string;
  kind: string;
  payload_json: string;
  status: string;
  label: string | null;
  ai_session_id: string | null;
  chat_id: number | null;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error: string | null;
}

function fromRow(r: Row): Job {
  return {
    id: r.id,
    kind: r.kind as Job["kind"],
    payload: JSON.parse(r.payload_json) as JobPayload,
    status: r.status as JobStatus,
    label: r.label ?? undefined,
    aiSessionId: r.ai_session_id ?? undefined,
    chatId: r.chat_id ?? undefined,
    pid: r.pid ?? undefined,
    createdAt: r.created_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    result: r.result_json ? (JSON.parse(r.result_json) as JobResult) : undefined,
    error: r.error ?? undefined,
  };
}

export function newJobId(): string {
  return randomUUID();
}

export function create(args: {
  kind: JobPayload["kind"];
  payload: JobPayload;
  label?: string;
  aiSessionId?: string;
  chatId?: number;
}): Job {
  const id = newJobId();
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO jobs (id, kind, payload_json, status, label, ai_session_id, chat_id, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).run(
    id,
    args.kind,
    JSON.stringify(args.payload),
    args.label ?? null,
    args.aiSessionId ?? null,
    args.chatId ?? null,
    now,
  );
  return read(id)!;
}

export function read(id: string): Job | null {
  const row = db().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function list(filter?: { status?: JobStatus; aiSessionId?: string; limit?: number }): Job[] {
  const limit = filter?.limit ?? 100;
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.status) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter?.aiSessionId) {
    where.push("ai_session_id = ?");
    params.push(filter.aiSessionId);
  }
  const sql =
    `SELECT * FROM jobs` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at DESC LIMIT ?`;
  const rows = db().prepare(sql).all(...params, limit) as Row[];
  return rows.map(fromRow);
}

// Outstanding = pending or running. Used by the system-prompt injection so
// the agent never loses track of what it dispatched.
export function listOutstandingForSession(aiSessionId: string): Job[] {
  const rows = db().prepare(
    `SELECT * FROM jobs
     WHERE ai_session_id = ? AND status IN ('pending', 'running')
     ORDER BY created_at ASC`,
  ).all(aiSessionId) as Row[];
  return rows.map(fromRow);
}

// Atomically claim a pending job: marks it 'running' and returns it. Returns
// null when no pending jobs exist or another worker grabbed it first.
// (Single-writer today; designed for safe extension to multi-worker.)
export function claimNext(): Job | null {
  return db().transaction((): Job | null => {
    const row = db().prepare(
      `SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    ).get() as Row | undefined;
    if (!row) return null;
    db().prepare(
      `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(new Date().toISOString(), row.id);
    return read(row.id);
  })();
}

export function setPid(id: string, pid: number | null): void {
  db().prepare(`UPDATE jobs SET pid = ? WHERE id = ?`).run(pid, id);
}

export function complete(id: string, result: JobResult): void {
  db().prepare(
    `UPDATE jobs SET status = 'succeeded', finished_at = ?, result_json = ?, pid = NULL WHERE id = ?`,
  ).run(new Date().toISOString(), JSON.stringify(result), id);
}

export function fail(id: string, error: string, result?: JobResult): void {
  db().prepare(
    `UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, result_json = ?, pid = NULL WHERE id = ?`,
  ).run(new Date().toISOString(), error, result ? JSON.stringify(result) : null, id);
}

export function cancel(id: string): boolean {
  const info = db().prepare(
    `UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('pending','running')`,
  ).run(new Date().toISOString(), id);
  return info.changes > 0;
}

// Sweep on startup: any jobs marked 'running' in the DB belong to a previous
// process (their child died with the parent). Mark them failed so the agent
// gets a chance to recover.
export function reapOrphaned(): number {
  const info = db().prepare(
    `UPDATE jobs
     SET status = 'failed', finished_at = ?, error = 'orphaned by server restart', pid = NULL
     WHERE status = 'running'`,
  ).run(new Date().toISOString());
  return info.changes;
}
