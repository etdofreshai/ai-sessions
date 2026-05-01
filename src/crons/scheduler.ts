import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { getProvider } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";
import { injectTurnOnSession } from "../runs/inject.js";
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

  if (t.kind === "ai_session") {
    const ai = aiStore.read(t.aiSessionId);
    if (!ai) throw new Error(`ai-session not found: ${t.aiSessionId}`);
    // Cron-fired runs deliberately do NOT resume the AiSession's existing
    // provider session: a cron fires with clean context every time so it
    // can't collide with whatever the user is doing in that session.
    await injectTurnOnSession(ai, t.prompt, {
      resumeSession: false,
      heralded: `⏰ \`${job.name}\``,
    });
    return;
  }

  // provider_session target: no AiSession wrapper, so we run directly and
  // skip channel fanout (no binding to fan out to).
  await runToCompletion(
    getProvider(t.provider).run({
      prompt: t.prompt,
      sessionId: t.sessionId,
      cwd: t.cwd,
      yolo: true,
    }),
  );
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

    const fresh = store.read(job.name);
    if (!fresh) continue;
    fresh.lastRunAt = new Date().toISOString();
    fresh.lastError = lastError;
    fresh.nextRunAt = nextFireAfter(fresh.cron, new Date(), fresh.timezone).toISOString();
    store.write(fresh);
  }
}

// On startup: handle jobs whose nextRunAt is already in the past based on
// missedPolicy. "skip" = realign to the next future fire. "run_once" = fire
// once now (handled by the normal tick — no-op here). "run_all" = fire once
// per missed slot, then realign.
async function catchUp(now: Date): Promise<void> {
  for (const job of store.list()) {
    if (!job.enabled) continue;
    if (new Date(job.nextRunAt) > now) continue;

    if (job.missedPolicy === "skip") {
      const fresh = store.read(job.name);
      if (!fresh) continue;
      fresh.nextRunAt = nextFireAfter(fresh.cron, now, fresh.timezone).toISOString();
      store.write(fresh);
      continue;
    }

    if (job.missedPolicy === "run_all") {
      // Each iteration fires once and advances next; bounded to avoid runaway
      // loops on long downtimes.
      let safety = 1000;
      while (safety-- > 0) {
        const fresh = store.read(job.name);
        if (!fresh || !fresh.enabled) break;
        if (new Date(fresh.nextRunAt) > new Date()) break;
        if (!tryClaim(fresh)) break;
        let lastError: string | undefined;
        try {
          await fire(fresh);
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
        const after = store.read(fresh.name);
        if (!after) break;
        after.lastRunAt = new Date().toISOString();
        after.lastError = lastError;
        after.nextRunAt = nextFireAfter(after.cron, new Date(after.nextRunAt), after.timezone).toISOString();
        store.write(after);
      }
    }
    // run_once falls through — the next tickOnce will fire it.
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
  catchUp(new Date())
    .catch((e) => console.error("[crons] catch-up error:", e))
    .finally(run);
  timer = setInterval(run, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
