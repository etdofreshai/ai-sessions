import * as aiStore from "../ai-sessions/store.js";
import * as subStore from "./store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";
import { channels as channelRegistry } from "../channels/index.js";
import type { SubAgent } from "./types.js";

export interface StartSubAgentArgs {
  parentAiSessionId: string;
  provider: string;
  prompt: string;
  cwd?: string;
  label?: string;
  // Optional Telegram chat id to direct-bind to the new child AiSession
  // for independent steering. Without this, the sub-agent has no inbound
  // channel of its own — the parent's chat sees a preview bubble via
  // hook routing instead.
  steerChatId?: number;
}

// Spawn a sub-agent: create a child AiSession, link it to the parent,
// run the prompt, and return the SubAgent record. Caller decides whether
// to await the run or fire-and-forget — the returned promise resolves
// when the run completes (or fails). For long-running sub-agents that
// the parent shouldn't block on, fire-and-forget by NOT awaiting; the
// SubAgent row + status will keep updating in the background.
export async function startSubAgent(args: StartSubAgentArgs): Promise<SubAgent> {
  // One-level-deep guard: if the parent itself is a sub-agent, refuse.
  // Keeps the topology flat and avoids "sub-sub-agents" we'd have to
  // reason about for hook routing, channel binding, and termination.
  if (subStore.isChild(args.parentAiSessionId)) {
    throw new Error(
      "one-level-deep policy: this AiSession is itself a sub-agent and cannot spawn sub-agents of its own",
    );
  }
  const parent = aiStore.read(args.parentAiSessionId);
  if (!parent) throw new Error(`parent ai-session not found: ${args.parentAiSessionId}`);
  if (!listProviderNames().includes(args.provider)) {
    throw new Error(`unknown provider: ${args.provider}`);
  }

  const child = aiStore.create({
    provider: args.provider,
    cwd: args.cwd ?? parent.cwd,
    name: args.label ?? null,
  });
  if (args.steerChatId != null) {
    child.channels = {
      ...(child.channels ?? {}),
      telegram: { chatId: args.steerChatId },
    };
    aiStore.write(child);
  }

  const sub = subStore.create({
    parentAiSessionId: parent.id,
    childAiSessionId: child.id,
    provider: args.provider,
    label: args.label,
  });

  // Kick the run. We don't await here — the caller decides whether to
  // block on completion. The promise updates the SubAgent row as it
  // progresses; hook events from the child's session_id route back to
  // the parent's preview bubble via hooks/dispatch.ts.
  void runChild(sub.id, child.id, args.prompt).catch((e) => {
    console.error(`[sub-agents] ${sub.id} run failed:`, e?.message ?? e);
  });

  return sub;
}

async function runChild(
  subId: string,
  childAiSessionId: string,
  prompt: string,
): Promise<void> {
  const child = aiStore.read(childAiSessionId);
  if (!child) {
    subStore.setStatus(subId, "failed");
    return;
  }
  subStore.setStatus(subId, "running");

  let providerSessionBound = false;
  const handle = getProvider(child.provider).run({
    prompt,
    aiSessionId: child.id,
    cwd: child.cwd,
    yolo: true,
    effort: child.reasoningEffort,
  });

  // Bind the provider session id as soon as we see it so PostToolUse hooks
  // routed by sessionId can find this sub-agent.
  void (async () => {
    try {
      for await (const ev of handle.events) {
        if (ev.type === "session_id" && !providerSessionBound) {
          subStore.bindProviderSession(subId, ev.sessionId);
          providerSessionBound = true;
        }
      }
    } catch {
      /* drained elsewhere */
    }
  })();

  const meta = await runToCompletion(handle);
  if (meta.status === "completed") {
    subStore.setStatus(subId, "completed");
  } else if (meta.status === "failed") {
    subStore.setStatus(subId, "failed");
  } else {
    subStore.setStatus(subId, "cancelled");
  }
  if (meta.output) subStore.setResultSummary(subId, meta.output);

  // If a chat is bound to the child OR (no direct bind) to the parent,
  // post the final reply there. Direct-bound child wins — that's where
  // someone steering the sub-agent expects to see results.
  const sub = subStore.read(subId);
  const parent = sub ? aiStore.read(sub.parentAiSessionId) : null;
  const dest = child.channels?.telegram?.chatId ?? parent?.channels?.telegram?.chatId;
  const channel = channelRegistry.telegram;
  if (channel && dest) {
    const text =
      (meta.output ?? "").trim() ||
      (meta.error ? `Run failed: ${meta.error}` : "(no output)");
    const header = `🤖 sub-agent ${sub?.id.slice(0, 8) ?? ""}${sub?.label ? ` (${sub.label})` : ""}: ${meta.status}`;
    try {
      await channel.send(
        { chatId: dest, threadId: child.channels?.telegram?.threadId ?? parent?.channels?.telegram?.threadId },
        { text: `${header}\n\n${text}` },
      );
    } catch (e: any) {
      console.error(`[sub-agents] ${subId} fanout failed:`, e?.message ?? e);
    }
  }
}
