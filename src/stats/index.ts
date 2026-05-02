// Aggregate stats across the SQLite tables for the dashboard's
// overview / stats view. Returns rolling counts (last 1h / 24h) and
// snapshot totals. Cheap — handful of indexed queries against tables
// that are already small.

import { db } from "../db/index.js";

export interface StatsSnapshot {
  generatedAt: string;
  subagents: {
    total: number;
    byStatus: Record<string, number>;
    createdLastHour: number;
    completedLastHour: number;
    failedLastHour: number;
    runningNow: number;
    longestRunningMs: number | null;
  };
  hooks: {
    total: number;
    lastHour: number;
    lastMinute: number;
    byEvent: Record<string, number>;       // last hour
    byHarness: Record<string, number>;     // last hour
  };
  sessions: {
    total: number;
    activeLastHour: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
  };
  crons: {
    total: number;
  };
}

export function snapshot(): StatsSnapshot {
  const conn = db();
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const minAgo  = new Date(now.getTime() - 60 * 1000).toISOString();

  // Subagents — bucket by status (non-deleted).
  const taskStatusRows = conn.prepare(
    `SELECT status, COUNT(*) AS n FROM sub_agent_tasks
      WHERE deleted_at IS NULL
      GROUP BY status`,
  ).all() as Array<{ status: string; n: number }>;
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of taskStatusRows) {
    byStatus[r.status] = r.n;
    total += r.n;
  }
  const createdLastHour = (conn.prepare(
    `SELECT COUNT(*) AS n FROM sub_agent_tasks
      WHERE created_at > ? AND deleted_at IS NULL`,
  ).get(hourAgo) as { n: number }).n;
  const completedLastHour = (conn.prepare(
    `SELECT COUNT(*) AS n FROM sub_agent_tasks
      WHERE finished_at > ? AND status = 'completed' AND deleted_at IS NULL`,
  ).get(hourAgo) as { n: number }).n;
  const failedLastHour = (conn.prepare(
    `SELECT COUNT(*) AS n FROM sub_agent_tasks
      WHERE finished_at > ? AND status IN ('failed','merge_failed') AND deleted_at IS NULL`,
  ).get(hourAgo) as { n: number }).n;
  const runningNow = byStatus.running ?? 0;
  const longestStarted = conn.prepare(
    `SELECT MIN(started_at) AS started FROM sub_agent_tasks
      WHERE status = 'running' AND deleted_at IS NULL`,
  ).get() as { started: string | null };
  const longestRunningMs = longestStarted?.started
    ? Date.now() - Date.parse(longestStarted.started)
    : null;

  // Hooks — last hour & last minute counts; bucket by event_name + harness.
  const hooksTotal = (conn.prepare(
    `SELECT COUNT(*) AS n FROM hook_events`,
  ).get() as { n: number }).n;
  const hooksLastHour = (conn.prepare(
    `SELECT COUNT(*) AS n FROM hook_events WHERE received_at > ?`,
  ).get(hourAgo) as { n: number }).n;
  const hooksLastMinute = (conn.prepare(
    `SELECT COUNT(*) AS n FROM hook_events WHERE received_at > ?`,
  ).get(minAgo) as { n: number }).n;
  const byEventRows = conn.prepare(
    `SELECT event_name, COUNT(*) AS n FROM hook_events
      WHERE received_at > ?
      GROUP BY event_name`,
  ).all(hourAgo) as Array<{ event_name: string; n: number }>;
  const byEvent: Record<string, number> = {};
  for (const r of byEventRows) byEvent[r.event_name] = r.n;
  const byHarnessRows = conn.prepare(
    `SELECT harness, COUNT(*) AS n FROM hook_events
      WHERE received_at > ?
      GROUP BY harness`,
  ).all(hourAgo) as Array<{ harness: string; n: number }>;
  const byHarness: Record<string, number> = {};
  for (const r of byHarnessRows) byHarness[r.harness] = r.n;

  // Sessions — count + activity.
  const sessionsTotal = (conn.prepare(
    `SELECT COUNT(*) AS n FROM ai_sessions`,
  ).get() as { n: number }).n;
  const activeLastHour = (conn.prepare(
    `SELECT COUNT(*) AS n FROM ai_sessions WHERE updated_at > ?`,
  ).get(hourAgo) as { n: number }).n;

  // Jobs.
  const jobsRows = conn.prepare(
    `SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`,
  ).all() as Array<{ status: string; n: number }>;
  const jobsByStatus: Record<string, number> = {};
  let jobsTotal = 0;
  for (const r of jobsRows) {
    jobsByStatus[r.status] = r.n;
    jobsTotal += r.n;
  }

  // Crons.
  const cronsTotal = (conn.prepare(
    `SELECT COUNT(*) AS n FROM crons`,
  ).get() as { n: number }).n;

  return {
    generatedAt: now.toISOString(),
    subagents: {
      total,
      byStatus,
      createdLastHour,
      completedLastHour,
      failedLastHour,
      runningNow,
      longestRunningMs,
    },
    hooks: {
      total: hooksTotal,
      lastHour: hooksLastHour,
      lastMinute: hooksLastMinute,
      byEvent,
      byHarness,
    },
    sessions: {
      total: sessionsTotal,
      activeLastHour,
    },
    jobs: {
      total: jobsTotal,
      byStatus: jobsByStatus,
    },
    crons: {
      total: cronsTotal,
    },
  };
}
