import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import { getProvider } from "../providers/index.js";
import * as aiStore from "../ai-sessions/store.js";
import { channels as channelRegistry } from "../channels/index.js";
import * as store from "./store.js";
import type { CronJob } from "./types.js";
import type { AiSession } from "../ai-sessions/types.js";
import type { RunMetadata } from "../runs/types.js";

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
  let aiSession: AiSession | null = null;

  if (t.kind === "ai_session") {
    const s = aiStore.read(t.aiSessionId);
    if (!s) throw new Error(`ai-session not found: ${t.aiSessionId}`);
    provider = s.provider;
    aiSessionId = s.id;
    aiSession = s;
    // Cron-fired runs deliberately do NOT resume the AiSession's existing
    // provider session: a cron should fire with a clean context every time,
    // not collide with whatever the user is doing in that session right now.
    // The AiSession is kept only as the addressing/binding handle — its
    // bound channel still receives the reply via fanOutToChannels below.
    sessionId = undefined;
  } else {
    provider = t.provider;
    sessionId = t.sessionId;
  }

  const handle = getProvider(provider).run({
    prompt: t.prompt,
    sessionId,
    // Cron runs are ephemeral: don't let attachToMeta overwrite the
    // AiSession's bound provider sessionId with this cron's fresh one.
    aiSessionId: aiSession ? undefined : aiSessionId,
    internal: aiSession ? true : undefined,
    cwd: t.cwd ?? aiSession?.cwd,
    yolo: true,
    effort: aiSession?.reasoningEffort,
  });
  // Drain events so the run actually executes. We don't relay tool/image
  // events from a cron-fired run yet — just the final text to bound channels.
  for await (const _ of handle.events) {
    /* discard */
  }
  const meta = await handle.done;

  // Fan out the run's final text to any channels bound to this AiSession.
  // User-initiated runs (e.g. Telegram /msg) already publish their own
  // status; cron-initiated runs need this hook explicitly.
  if (aiSession) await fanOutToChannels(aiSession, meta, job);
}

async function fanOutToChannels(
  ai: AiSession,
  meta: RunMetadata,
  job: CronJob,
): Promise<void> {
  const chatId = ai.channels?.telegram?.chatId;
  if (!chatId) return;
  const channel = channelRegistry.telegram;
  if (!channel) return;
  const text = (meta.output ?? "").trim();
  const body = text || (meta.error ? `Run failed: ${meta.error}` : "(no output)");
  // Cron-fired runs aren't tied to a user message, so prefix with the job
  // name — otherwise the bubble feels like it appeared out of nowhere.
  const out = `⏰ \`${job.name}\`\n\n${body}`;
  try {
    await channel.send(
      { chatId, threadId: ai.channels?.telegram?.threadId },
      { text: out },
    );
    console.error(`[crons] fanOut ok name=${job.name} chat=${chatId} bytes=${out.length}`);
  } catch (e: any) {
    console.error(`[crons] fanOut to telegram chat ${chatId} failed: ${e?.message ?? e}`);
  }
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
