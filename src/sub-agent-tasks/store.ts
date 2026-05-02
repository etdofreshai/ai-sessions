import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type {
  SubAgentTask,
  SubAgentTaskDependency,
  SubAgentTaskEvent,
  TaskEventType,
  TaskMergeStrategy,
  TaskStatus,
} from "./types.js";

interface TaskRow {
  id: string;
  ai_session_id: string;
  title: string;
  prompt: string;
  response: string | null;
  status: string;
  provider: string | null;
  provider_session_id: string | null;
  sub_agent_id: string | null;
  effort: string | null;
  cwd: string | null;
  base_ref: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  merge_strategy: string;
  attempt_count: number;
  max_attempts: number;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  deleted_at: string | null;
}

interface DepRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

interface EventRow {
  id: string;
  task_id: string;
  event_type: string;
  message: string | null;
  created_at: string;
}

function fromTaskRow(r: TaskRow): SubAgentTask {
  return {
    id: r.id,
    aiSessionId: r.ai_session_id,
    title: r.title,
    prompt: r.prompt,
    response: r.response ?? undefined,
    status: r.status as TaskStatus,
    provider: r.provider ?? undefined,
    providerSessionId: r.provider_session_id ?? undefined,
    subAgentId: r.sub_agent_id ?? undefined,
    effort: r.effort ?? undefined,
    cwd: r.cwd ?? undefined,
    baseRef: r.base_ref ?? undefined,
    branchName: r.branch_name ?? undefined,
    worktreePath: r.worktree_path ?? undefined,
    mergeStrategy: r.merge_strategy as TaskMergeStrategy,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    timeoutSeconds: r.timeout_seconds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at ?? undefined,
    finishedAt: r.finished_at ?? undefined,
    deletedAt: r.deleted_at ?? undefined,
  };
}

function fromDepRow(r: DepRow): SubAgentTaskDependency {
  return {
    id: r.id,
    taskId: r.task_id,
    dependsOnTaskId: r.depends_on_task_id,
    createdAt: r.created_at,
  };
}

function fromEventRow(r: EventRow): SubAgentTaskEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    eventType: r.event_type as TaskEventType,
    message: r.message ?? undefined,
    createdAt: r.created_at,
  };
}

export function newTaskId(): string {
  return randomUUID();
}

function appendEventInternal(
  taskId: string,
  eventType: TaskEventType,
  message?: string,
): void {
  db().prepare(
    `INSERT INTO sub_agent_task_events (id, task_id, event_type, message, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), taskId, eventType, message ?? null, new Date().toISOString());
}

export function appendEvent(
  taskId: string,
  eventType: TaskEventType,
  message?: string,
): void {
  appendEventInternal(taskId, eventType, message);
}

export interface CreateTaskArgs {
  aiSessionId: string;
  title: string;
  prompt: string;
  provider?: string;
  effort?: string;
  cwd?: string;
  baseRef?: string;
  branchName?: string;
  worktreePath?: string;
  mergeStrategy?: TaskMergeStrategy;
  maxAttempts?: number;
  timeoutSeconds?: number;
  dependsOn?: string[];
}

export function create(args: CreateTaskArgs): SubAgentTask {
  const id = newTaskId();
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO sub_agent_tasks
       (id, ai_session_id, title, prompt, status,
        provider, effort, cwd, base_ref, branch_name, worktree_path,
        merge_strategy, attempt_count, max_attempts, timeout_seconds,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'created',
             ?, ?, ?, ?, ?, ?,
             ?, 0, ?, ?,
             ?, ?)`,
  ).run(
    id,
    args.aiSessionId,
    args.title,
    args.prompt,
    args.provider ?? null,
    args.effort ?? null,
    args.cwd ?? null,
    args.baseRef ?? null,
    args.branchName ?? null,
    args.worktreePath ?? null,
    args.mergeStrategy ?? "auto",
    args.maxAttempts ?? 2,
    args.timeoutSeconds ?? 1200,
    now,
    now,
  );
  appendEventInternal(id, "created");
  if (args.dependsOn?.length) {
    for (const depId of args.dependsOn) {
      addDependency(id, depId);
    }
  }
  return read(id)!;
}

export function read(id: string): SubAgentTask | null {
  const row = db().prepare(
    `SELECT * FROM sub_agent_tasks WHERE id = ?`,
  ).get(id) as TaskRow | undefined;
  return row ? fromTaskRow(row) : null;
}

export interface ListFilter {
  aiSessionId?: string;
  status?: TaskStatus;
  includeDeleted?: boolean;
}

export function list(filter: ListFilter = {}): SubAgentTask[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.aiSessionId) {
    where.push(`ai_session_id = ?`);
    params.push(filter.aiSessionId);
  }
  if (filter.status) {
    where.push(`status = ?`);
    params.push(filter.status);
  }
  if (!filter.includeDeleted) {
    where.push(`deleted_at IS NULL`);
  }
  const sql =
    `SELECT * FROM sub_agent_tasks` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY created_at ASC`;
  const rows = db().prepare(sql).all(...params) as TaskRow[];
  return rows.map(fromTaskRow);
}

export interface UpdateTaskArgs {
  title?: string;
  prompt?: string;
  provider?: string;
  effort?: string;
  cwd?: string;
  baseRef?: string;
  branchName?: string;
  worktreePath?: string;
  mergeStrategy?: TaskMergeStrategy;
  maxAttempts?: number;
  timeoutSeconds?: number;
}

export function update(id: string, args: UpdateTaskArgs): SubAgentTask | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, string> = {
    title: "title",
    prompt: "prompt",
    provider: "provider",
    effort: "effort",
    cwd: "cwd",
    baseRef: "base_ref",
    branchName: "branch_name",
    worktreePath: "worktree_path",
    mergeStrategy: "merge_strategy",
    maxAttempts: "max_attempts",
    timeoutSeconds: "timeout_seconds",
  };
  for (const [k, col] of Object.entries(map)) {
    if ((args as Record<string, unknown>)[k] !== undefined) {
      sets.push(`${col} = ?`);
      params.push((args as Record<string, unknown>)[k]);
    }
  }
  if (!sets.length) return read(id);
  sets.push(`updated_at = ?`);
  params.push(new Date().toISOString());
  params.push(id);
  db().prepare(
    `UPDATE sub_agent_tasks SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params);
  return read(id);
}

export function softDelete(id: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks SET deleted_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, id);
}

export function markStarted(args: {
  taskId: string;
  provider: string;
  providerSessionId?: string;
  subAgentId?: string;
}): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks
        SET status = 'running',
            provider = ?,
            provider_session_id = COALESCE(?, provider_session_id),
            sub_agent_id = COALESCE(?, sub_agent_id),
            attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?),
            updated_at = ?
      WHERE id = ?`,
  ).run(
    args.provider,
    args.providerSessionId ?? null,
    args.subAgentId ?? null,
    now,
    now,
    args.taskId,
  );
  appendEventInternal(args.taskId, "started");
}

export function touchActivity(id: string, message?: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks SET updated_at = ? WHERE id = ?`,
  ).run(now, id);
  appendEventInternal(id, "activity", message);
}

export function bindProviderSession(id: string, providerSessionId: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks SET provider_session_id = ?, updated_at = ? WHERE id = ?`,
  ).run(providerSessionId, now, id);
}

export function complete(id: string, response?: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks
        SET status = 'completed',
            response = ?,
            finished_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(response ?? null, now, now, id);
  appendEventInternal(id, "completed");
}

export function fail(id: string, response?: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks
        SET status = 'failed',
            response = ?,
            finished_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(response ?? null, now, now, id);
  appendEventInternal(id, "failed", response);
}

export function markMergeFailed(id: string, response: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks
        SET status = 'merge_failed',
            response = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(response, now, id);
  appendEventInternal(id, "merge_failed", response);
}

export function cancel(id: string, reason?: string): void {
  const now = new Date().toISOString();
  db().prepare(
    `UPDATE sub_agent_tasks
        SET status = 'cancelled',
            response = COALESCE(?, response),
            finished_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(reason ?? null, now, now, id);
  appendEventInternal(id, "cancelled", reason);
}

export function recordRetry(id: string, message?: string): void {
  appendEventInternal(id, "retry", message);
}

// A task is runnable when status='created', not deleted, and every
// dependency is 'completed'. Used by the scheduler to find dispatch
// candidates.
export function listRunnable(aiSessionId: string): SubAgentTask[] {
  const rows = db().prepare(
    `SELECT t.*
       FROM sub_agent_tasks t
      WHERE t.ai_session_id = ?
        AND t.status = 'created'
        AND t.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM sub_agent_task_dependencies d
            JOIN sub_agent_tasks dep
              ON dep.id = d.depends_on_task_id
           WHERE d.task_id = t.id
             AND dep.status != 'completed'
        )
      ORDER BY t.created_at ASC`,
  ).all(aiSessionId) as TaskRow[];
  return rows.map(fromTaskRow);
}

// A task is stale when it's running and its updated_at is older than
// timeout_seconds ago. The stale check uses SQLite's datetime arithmetic
// against the row's own timeout so per-task overrides work.
export function listStale(): SubAgentTask[] {
  const rows = db().prepare(
    `SELECT *
       FROM sub_agent_tasks
      WHERE status = 'running'
        AND deleted_at IS NULL
        AND datetime(updated_at, '+' || timeout_seconds || ' seconds')
            < datetime(?)`,
  ).all(new Date().toISOString()) as TaskRow[];
  return rows.map(fromTaskRow);
}

// Dependency management.
export function addDependency(
  taskId: string,
  dependsOnTaskId: string,
): SubAgentTaskDependency | null {
  if (taskId === dependsOnTaskId) {
    throw new Error("a task cannot depend on itself");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    db().prepare(
      `INSERT INTO sub_agent_task_dependencies
         (id, task_id, depends_on_task_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(id, taskId, dependsOnTaskId, now);
  } catch (e: unknown) {
    // UNIQUE constraint — dependency already exists; return existing.
    const existing = db().prepare(
      `SELECT * FROM sub_agent_task_dependencies
        WHERE task_id = ? AND depends_on_task_id = ?`,
    ).get(taskId, dependsOnTaskId) as DepRow | undefined;
    if (existing) return fromDepRow(existing);
    throw e;
  }
  appendEventInternal(taskId, "dependency_added", dependsOnTaskId);
  return fromDepRow(
    db().prepare(`SELECT * FROM sub_agent_task_dependencies WHERE id = ?`)
      .get(id) as DepRow,
  );
}

export function removeDependency(
  taskId: string,
  dependsOnTaskId: string,
): boolean {
  const info = db().prepare(
    `DELETE FROM sub_agent_task_dependencies
      WHERE task_id = ? AND depends_on_task_id = ?`,
  ).run(taskId, dependsOnTaskId);
  if (info.changes > 0) {
    appendEventInternal(taskId, "dependency_removed", dependsOnTaskId);
    return true;
  }
  return false;
}

export function listDependencies(taskId: string): SubAgentTaskDependency[] {
  const rows = db().prepare(
    `SELECT * FROM sub_agent_task_dependencies
      WHERE task_id = ? ORDER BY created_at ASC`,
  ).all(taskId) as DepRow[];
  return rows.map(fromDepRow);
}

export function listDependents(taskId: string): SubAgentTaskDependency[] {
  const rows = db().prepare(
    `SELECT * FROM sub_agent_task_dependencies
      WHERE depends_on_task_id = ? ORDER BY created_at ASC`,
  ).all(taskId) as DepRow[];
  return rows.map(fromDepRow);
}

export function listEvents(taskId: string, limit = 200): SubAgentTaskEvent[] {
  const rows = db().prepare(
    `SELECT * FROM sub_agent_task_events
      WHERE task_id = ? ORDER BY created_at ASC LIMIT ?`,
  ).all(taskId, limit) as EventRow[];
  return rows.map(fromEventRow);
}

// Reverse lookups used when wiring activity/completion from the existing
// sub_agents pipeline back to the owning task.
export function findByProviderSession(
  providerSessionId: string,
): SubAgentTask | null {
  const row = db().prepare(
    `SELECT * FROM sub_agent_tasks WHERE provider_session_id = ? LIMIT 1`,
  ).get(providerSessionId) as TaskRow | undefined;
  return row ? fromTaskRow(row) : null;
}

export function findBySubAgentId(subAgentId: string): SubAgentTask | null {
  const row = db().prepare(
    `SELECT * FROM sub_agent_tasks WHERE sub_agent_id = ? LIMIT 1`,
  ).get(subAgentId) as TaskRow | undefined;
  return row ? fromTaskRow(row) : null;
}
