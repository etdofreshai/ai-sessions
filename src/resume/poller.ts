import { existsSync, readFileSync, statSync } from "node:fs";
import * as aiStore from "../ai-sessions/store.js";
import type { AiSession, ResumeBgTask } from "../ai-sessions/types.js";
import { injectTurnOnSession } from "../runs/inject.js";
import { disableResume, dropPendingTask, isResumeExpired } from "./state.js";

const TICK_MS = 5_000;
// A task is "done" when its output file's mtime hasn't moved for this long.
const QUIESCENT_MS = 5_000;
// Cap how much output we feed back into the model — keep prompts cheap.
const TAIL_BYTES = 4_000;

let timer: NodeJS.Timeout | null = null;

export function startResumePoller(): void {
  if (timer) return;
  const run = (): void => {
    tickOnce().catch((e) => console.error("[resume] tick error:", e));
  };
  run();
  timer = setInterval(run, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopResumePoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tickOnce(): Promise<void> {
  for (const ai of aiStore.list()) {
    if (ai.resume !== true) continue;
    if (isResumeExpired(ai)) {
      console.error(`[resume] ${ai.id}: TTL expired, disabling`);
      disableResume(ai);
      continue;
    }
    const pending = ai.resumePendingTasks ?? [];
    if (pending.length === 0) continue;
    const completed: Array<ResumeBgTask & { tail: string }> = [];
    for (const task of pending) {
      const tail = readIfQuiescent(task);
      if (tail !== null) completed.push({ ...task, tail });
    }
    if (completed.length === 0) continue;

    try {
      await fireResume(ai, completed);
      // Drop only on success — a transient provider failure shouldn't lose
      // the resume work. Next tick will retry the same set of completed
      // tasks. (Re-firing the same coalesced batch is fine; the model just
      // sees the same prompt twice in the worst case.)
      for (const c of completed) dropPendingTask(ai.id, c.id);
    } catch (e: any) {
      console.error(`[resume] ${ai.id}: fire failed, will retry next tick:`, e?.message ?? e);
    }
  }
}

// Returns the tail of the output file when it looks complete; null otherwise.
// "Complete" here means: file exists and its mtime is at least QUIESCENT_MS
// in the past. Cheap and works for both Bash and Agent bg tasks.
function readIfQuiescent(task: ResumeBgTask): string | null {
  if (!existsSync(task.outputFile)) return null;
  let st;
  try {
    st = statSync(task.outputFile);
  } catch {
    return null;
  }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < QUIESCENT_MS) return null;
  // Only consider tasks that have been running long enough to plausibly have
  // finished — avoids re-firing on a launch we just captured this tick.
  const launchedMs = Date.now() - new Date(task.launchedAt).getTime();
  if (launchedMs < QUIESCENT_MS) return null;
  try {
    const buf = readFileSync(task.outputFile);
    const slice = buf.subarray(Math.max(0, buf.length - TAIL_BYTES));
    return slice.toString("utf8");
  } catch {
    return null;
  }
}

async function fireResume(
  ai: AiSession,
  completed: Array<ResumeBgTask & { tail: string }>,
): Promise<void> {
  const ids = completed.map((c) => c.id).join(", ");
  await injectTurnOnSession(ai, buildResumePrompt(completed), {
    resumeSession: true,
    heralded: `⚙️ resume: bg task${completed.length > 1 ? "s" : ""} ${ids} finished — re-entering session`,
  });
}

function buildResumePrompt(
  completed: Array<ResumeBgTask & { tail: string }>,
): string {
  const blocks = completed.map((c) => {
    const header = `[bg ${c.kind} ${c.id}${c.label ? ` — ${c.label}` : ""}]`;
    return `${header}\n${c.tail.trimEnd()}`;
  });
  const lead =
    completed.length === 1
      ? "A background task you launched finished. Output:"
      : `${completed.length} background tasks finished. Outputs:`;
  return [
    lead,
    "",
    blocks.join("\n\n---\n\n"),
    "",
    "Continue from where you left off based on these results.",
  ].join("\n");
}
