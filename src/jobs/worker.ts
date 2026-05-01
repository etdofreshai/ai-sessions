import { spawn } from "node:child_process";
import * as jobsStore from "./store.js";
import * as aiStore from "../ai-sessions/store.js";
import { getProvider } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";
import { channels as channelRegistry } from "../channels/index.js";
import type { Job, JobResultBash } from "./types.js";

const TICK_MS = 5_000;
const TAIL_BYTES = 4_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startJobWorker(): void {
  if (timer) return;
  // Anything left as 'running' from a prior process is orphaned — the child
  // died with the server. Fail those so the agent can retry / move on.
  const reaped = jobsStore.reapOrphaned();
  if (reaped > 0) console.error(`[jobs] reaped ${reaped} orphaned running jobs on boot`);

  const tick = (): void => {
    if (inFlight) return; // single-threaded executor; jobs run sequentially
    void claimAndRun().catch((e) =>
      console.error("[jobs] tick error:", e?.message ?? e),
    );
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopJobWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function claimAndRun(): Promise<void> {
  const job = jobsStore.claimNext();
  if (!job) return;
  inFlight = true;
  try {
    await runJob(job);
  } finally {
    inFlight = false;
  }
}

async function runJob(job: Job): Promise<void> {
  console.error(`[jobs] running ${job.id} kind=${job.kind} label=${job.label ?? "(none)"}`);
  let result: JobResultBash | undefined;
  let error: string | undefined;
  try {
    if (job.payload.kind === "bash") {
      result = await runBash(job, job.payload);
    } else {
      throw new Error(`unknown job kind: ${(job.payload as { kind?: string }).kind}`);
    }
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  if (error) {
    jobsStore.fail(job.id, error, result);
    console.error(`[jobs] ${job.id} failed: ${error}`);
  } else if (result) {
    jobsStore.complete(job.id, result);
    console.error(`[jobs] ${job.id} succeeded (exit ${result.exitCode})`);
  }

  await injectResult(job.id);
}

async function runBash(
  job: Job,
  payload: { kind: "bash"; cmd: string; cwd?: string; timeoutMs?: number },
): Promise<JobResultBash> {
  return new Promise((resolve, reject) => {
    // Use bash -lc so the command can use shell features (pipes, redirects,
    // env). We capture combined stdout+stderr — for long-running jobs, only
    // the tail goes back into the agent's prompt to keep token costs bounded.
    const child = spawn("bash", ["-lc", payload.cmd], {
      cwd: payload.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    jobsStore.setPid(job.id, child.pid ?? null);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const onData = (b: Buffer): void => {
      chunks.push(b);
      totalBytes += b.length;
      // Trim on the fly: keep only the trailing TAIL_BYTES so memory stays
      // bounded for hours-long log streams.
      let kept = chunks.reduce((n, c) => n + c.length, 0);
      while (kept > TAIL_BYTES * 2 && chunks.length > 1) {
        kept -= chunks.shift()!.length;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timer: NodeJS.Timeout | null = null;
    if (payload.timeoutMs && payload.timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, payload.timeoutMs);
    }

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      const buf = Buffer.concat(chunks);
      const tail = buf.subarray(Math.max(0, buf.length - TAIL_BYTES)).toString("utf8");
      resolve({
        kind: "bash",
        exitCode: code,
        signal: signal ?? undefined,
        outputTail: tail,
        totalBytes,
      });
    });
  });
}

// After a job lands, re-enter the originating AiSession with the result so
// the agent can reason about it as the next turn — same pattern cron and
// resume use. If no AiSession is bound, the job is fire-and-forget; we
// just record the result and stop.
async function injectResult(jobId: string): Promise<void> {
  const job = jobsStore.read(jobId);
  if (!job) return;
  if (!job.aiSessionId) return;
  const ai = aiStore.read(job.aiSessionId);
  if (!ai) {
    console.error(`[jobs] ${jobId} ai-session ${job.aiSessionId} gone — skipping injection`);
    return;
  }

  const channel = channelRegistry.telegram;
  const chatId = job.chatId ?? ai.channels?.telegram?.chatId;
  if (channel && chatId) {
    try {
      await channel.send(
        { chatId, threadId: ai.channels?.telegram?.threadId },
        {
          text: `⚙️ job ${job.id.slice(0, 8)}${job.label ? ` (${job.label})` : ""} ${
            job.status
          } — re-entering session`,
        },
      );
    } catch {
      /* best-effort */
    }
  }

  const meta = await runToCompletion(
    getProvider(ai.provider).run({
      prompt: buildInjectionPrompt(job),
      sessionId: ai.sessionId,
      aiSessionId: ai.id,
      cwd: ai.cwd,
      yolo: true,
      effort: ai.reasoningEffort,
    }),
  );

  if (channel && chatId) {
    const text =
      (meta.output ?? "").trim() ||
      (meta.error ? `Run failed: ${meta.error}` : "(no output)");
    try {
      await channel.send(
        { chatId, threadId: ai.channels?.telegram?.threadId },
        { text },
      );
    } catch (e: any) {
      console.error(`[jobs] fanout to chat ${chatId} failed:`, e?.message ?? e);
    }
  }
}

function buildInjectionPrompt(job: Job): string {
  const header = `[job ${job.id} kind=${job.kind} status=${job.status}${
    job.label ? ` label="${job.label}"` : ""
  }]`;
  if (job.error) {
    return [
      header,
      `error: ${job.error}`,
      "",
      "Continue from where you left off — handle this failure and decide whether to retry, work around, or escalate.",
    ].join("\n");
  }
  if (job.result?.kind === "bash") {
    const r = job.result;
    return [
      header,
      `exit code: ${r.exitCode}${r.signal ? ` (signal ${r.signal})` : ""}`,
      `total output bytes: ${r.totalBytes}`,
      "",
      "output (tail):",
      r.outputTail.trimEnd(),
      "",
      "Continue from where you left off based on this result.",
    ].join("\n");
  }
  return `${header}\n\nContinue from where you left off based on this result.`;
}
