import { getProvider } from "../providers/index.js";
import { runToCompletion } from "./drain.js";
import { channels as channelRegistry } from "../channels/index.js";
import type { AiSession } from "../ai-sessions/types.js";
import type { RunMetadata } from "./types.js";

export interface InjectTurnOptions {
  // Resume the AiSession's current provider session (persistent context).
  // When false, runs in a fresh provider session — useful for cron-fired
  // turns that shouldn't pick up the live conversation's context.
  resumeSession?: boolean;
  // Optional one-line heads-up sent to the bound channel BEFORE the new
  // turn fires, so an unprompted bubble has context. e.g.
  // "⏰ daily-report" or "⚙️ resume after bg task X".
  heralded?: string;
  // Skip channel fanout entirely — the run still happens, but no message
  // is posted. Useful for fire-and-forget jobs.
  noFanout?: boolean;
}

// Run a prompt on an AiSession (resumed or fresh) and fan the final reply
// out to the bound channel. The shared path used by cron, resume, and the
// long-jobs worker — all "external event becomes the next turn" flows
// converge here.
export async function injectTurnOnSession(
  ai: AiSession,
  prompt: string,
  opts: InjectTurnOptions = {},
): Promise<RunMetadata> {
  const channel = channelRegistry.telegram;
  const chatId = ai.channels?.telegram?.chatId;
  const threadId = ai.channels?.telegram?.threadId;

  if (opts.heralded && !opts.noFanout && channel && chatId) {
    try {
      await channel.send({ chatId, threadId }, { text: opts.heralded });
    } catch {
      /* best-effort */
    }
  }

  const resume = opts.resumeSession ?? true;
  const meta = await runToCompletion(
    getProvider(ai.provider).run({
      prompt,
      // Resume vs fresh: when fresh, also mark internal so attachToMeta
      // doesn't overwrite the AiSession's stored sessionId with the
      // throwaway one.
      sessionId: resume ? ai.sessionId : undefined,
      aiSessionId: resume ? ai.id : undefined,
      internal: resume ? undefined : true,
      cwd: ai.cwd,
      yolo: true,
      effort: ai.reasoningEffort,
    }),
  );

  if (!opts.noFanout && channel && chatId) {
    const text =
      (meta.output ?? "").trim() ||
      (meta.error ? `Run failed: ${meta.error}` : "(no output)");
    try {
      await channel.send({ chatId, threadId }, { text });
    } catch (e: any) {
      console.error(`[inject] fanout to chat ${chatId} failed:`, e?.message ?? e);
    }
  }

  return meta;
}
