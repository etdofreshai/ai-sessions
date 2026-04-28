import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { getProvider } from "../providers/index.js";
import * as aiStore from "../ai-sessions/store.js";
import * as store from "./store.js";
import type { CronJob } from "./types.js";

const TICK_MS = 30_000;

export function nextFireAfter(cron: string, after: Date, tz?: string): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: after, tz });
  return it.next().toDate();
}

export function makeJob(input: {
  name: string;
  cron: string;
  target: CronJob["target"];
  timezone?: string;
  missedPolicy?: CronJob["missedPolicy"];
}): CronJob {
  const now = new Date();
  return {
    name: input.name,
    cron: input.cron,
    timezone: input.timezone,
    target: input.target,
    enabled: true,
    missedPolicy: input.missedPolicy ?? "skip",
    nextRunAt: nextFireAfter(input.cron, now, input.timezone).toISOString(),
    createdAt: now.toISOString(),
  };
}

async function fire(job: CronJob): Promise<void> {
  const t = job.target;
  if (t.kind === "command") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(t.command, t.args ?? [], {
        cwd: t.cwd,
        stdio: "inherit",
        shell: false,
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`))
      );
    });
    return;
  }

  let provider: string;
  let sessionId: string | undefined;
  let aiSessionId: string | undefined;

  if (t.kind === "ai_session") {
    const s = aiStore.read(t.aiSessionId);
    if (!s) throw new Error(`ai-session not found: ${t.aiSessionId}`);
    provider = s.provider;
    sessionId = s.sessionId;
    aiSessionId = s.id;
  } else {
    provider = t.provider;
    sessionId = t.sessionId;
  }

  const handle = getProvider(provider).run({
    prompt: t.prompt,
    sessionId,
    aiSessionId,
    cwd: t.cwd,
    yolo: true,
  });
  // Drain events so the run actually executes; we don't surface output.
  for await (const _ of handle.events) {
    /* discard */
  }
  await handle.done;
}

// Returns true if this process won the race to fire the job.
function tryClaim(job: CronJob): boolean {
  const fresh = store.read(job.name);
  if (!fresh) return false;
  if (fresh.lastStartedAt && fresh.lastStartedAt >= job.nextRunAt) return false;
  fresh.lastStartedAt = new Date().toISOString();
  store.write(fresh);
  return true;
}

async function tickOnce(now: Date): Promise<void> {
  for (const job of store.list()) {
    if (!job.enabled) continue;
    if (new Date(job.nextRunAt) > now) continue;
    if (!tryClaim(job)) continue;

    let lastError: string | undefined;
    try {
      await fire(job);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    // Recompute next run. For run_all we'd loop until next > now; default skips
    // missed slots and just schedules the next future fire.
    const fresh = store.read(job.name);
    if (!fresh) continue;
    fresh.lastRunAt = new Date().toISOString();
    fresh.lastError = lastError;
    fresh.nextRunAt = nextFireAfter(fresh.cron, new Date(), fresh.timezone).toISOString();
    store.write(fresh);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  const run = (): void => {
    tickOnce(new Date()).catch((e) => {
      console.error("[crons] tick error:", e);
    });
  };
  run();
  timer = setInterval(run, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
