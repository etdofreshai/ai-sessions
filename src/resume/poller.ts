import { existsSync, readFileSync, statSync } from "node:fs";
import * as aiStore from "../ai-sessions/store.js";
import type { AiSession, ResumeBgTask } from "../ai-sessions/types.js";
import { getProvider } from "../providers/index.js";
import { channels as channelRegistry } from "../channels/index.js";
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

    // Drop them up front so we can't double-fire if the next tick lands
    // before our re-entry turn finishes.
    for (const c of completed) dropPendingTask(ai.id, c.id);

    try {
      await fireResume(ai, completed);
    } catch (e: any) {
      console.error(`[resume] ${ai.id}: fire failed:`, e?.message ?? e);
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
  const channel = channelRegistry.telegram;
  const chatId = ai.channels?.telegram?.chatId;

  // Friendly heads-up before the re-entry turn lands, so the unprompted
  // bubble has context.
  if (channel && chatId) {
    const ids = completed.map((c) => c.id).join(", ");
    try {
      await channel.send(
        { chatId, threadId: ai.channels?.telegram?.threadId },
        { text: `⚙️ resume: bg task${completed.length > 1 ? "s" : ""} ${ids} finished — re-entering session` },
      );
    } catch {
      /* best-effort */
    }
  }

  const prompt = buildResumePrompt(completed);
  const handle = getProvider(ai.provider).run({
    prompt,
    sessionId: ai.sessionId, // resume the same conversation
    aiSessionId: ai.id,
    cwd: ai.cwd,
    yolo: true,
    effort: ai.reasoningEffort,
  });
  for await (const _ of handle.events) {
    /* discard intermediate events; final fanout below */
  }
  const meta = await handle.done;

  if (channel && chatId) {
    const text = (meta.output ?? "").trim() || (meta.error ? `Run failed: ${meta.error}` : "(no output)");
    try {
      await channel.send(
        { chatId, threadId: ai.channels?.telegram?.threadId },
        { text },
      );
    } catch (e: any) {
      console.error(`[resume] fanout to chat ${chatId} failed:`, e?.message ?? e);
    }
  }
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
