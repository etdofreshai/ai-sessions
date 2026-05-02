// Sub-agent task scheduler.
//
// The supervisor LLM owns dispatch (it picks providers, calls
// /sub-agent-tasks/:id/dispatch, decides retries). The scheduler exists
// for the deterministic background work the supervisor can't do mid-turn:
//
//   - Detect tasks whose `running` heartbeat went stale past timeout_seconds
//     and flip them to `failed` with a stale-timeout response.
//   - On stale, if attempt_count < max_attempts, automatically reset to
//     `created` so the supervisor's next dispatch can re-launch on a
//     different provider.
//
// We don't auto-launch ready tasks here. That's the supervisor's job.

import { db } from "../db/index.js";
import * as store from "./store.js";

const TICK_MS = 30_000;

const STALE_MESSAGE =
  "Task failed because it went stale after timeout (no activity within timeout_seconds).";

export interface TickResult {
  staleFailed: number;
  staleRetried: number;
}

export async function tickOnce(): Promise<TickResult> {
  const stale = store.listStale();
  let failed = 0;
  let retried = 0;
  for (const task of stale) {
    if (task.attemptCount < task.maxAttempts) {
      // Reset to created so the supervisor can re-launch. attempt_count is
      // already bumped from the previous markStarted, so re-launch will
      // bump it again on the next dispatch.
      const now = new Date().toISOString();
      db().prepare(
        `UPDATE sub_agent_tasks
            SET status = 'created',
                provider_session_id = NULL,
                sub_agent_id = NULL,
                started_at = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(now, task.id);
      store.appendEvent(
        task.id,
        "retry",
        `stale after ${task.timeoutSeconds}s; resetting to created (attempt ${task.attemptCount}/${task.maxAttempts})`,
      );
      retried++;
    } else {
      store.fail(task.id, STALE_MESSAGE);
      failed++;
    }
  }
  return { staleFailed: failed, staleRetried: retried };
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  const run = (): void => {
    tickOnce().catch((e) => {
      console.error("[sub-agent-tasks] tick error:", e);
    });
  };
  // Don't run an initial tick on startup — let the first interval fire.
  timer = setInterval(run, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
