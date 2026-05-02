import * as aiStore from "../ai-sessions/store.js";
import * as subStore from "./store.js";
import * as taskStore from "../sub-agent-tasks/store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { telegramChannel } from "../channels/telegram.js";
import * as turnsRegistry from "../turns/registry.js";
import { injectTurnOnSession } from "../runs/inject.js";
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
  // Optional sub_agent_tasks.id this dispatch fulfills. When set, the
  // runner mirrors lifecycle (started/activity/completed/failed) onto the
  // task row so the supervisor can resume long plans across restarts.
  taskId?: string;
  effort?: string;
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
  console.log(
    `[subagents] launch sub=${sub.id.slice(0, 8)} task=${args.taskId?.slice(0, 8) ?? "-"} provider=${args.provider} parent=${parent.id.slice(0, 8)} cwd=${args.cwd ?? parent.cwd ?? "-"} label="${(args.label ?? "").slice(0, 60)}"`,
  );

  // If this dispatch fulfills a sub_agent_tasks row, link the two and
  // bump the task into 'running' immediately. The provider session id
  // gets backfilled in runChild on the first session_id event.
  if (args.taskId) {
    try {
      taskStore.markStarted({
        taskId: args.taskId,
        provider: args.provider,
        subAgentId: sub.id,
      });
    } catch (e: unknown) {
      console.error(
        `[sub-agents] task ${args.taskId} markStarted failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Kick the run. We don't await here — the caller decides whether to
  // block on completion. The promise updates the SubAgent row as it
  // progresses; hook events from the child's session_id route back to
  // the parent's preview bubble via hooks/dispatch.ts.
  void runChild(sub.id, child.id, args.prompt, args.taskId).catch((e) => {
    console.error(`[sub-agents] ${sub.id} run failed:`, e?.message ?? e);
  });

  return sub;
}

// Cancel a running/pending sub-agent. Resolves the child's ActiveTurn
// (registered in runChild) and calls handle.interrupt() so the provider
// tears the run down cleanly; runChild's drain then sets the row to
// "cancelled" via terminal-status mapping. Falls back to flipping the
// status directly when no live handle exists (e.g. server restarted).
export function cancelSubAgent(id: string): boolean {
  const sub = subStore.read(id);
  if (!sub) return false;
  const turn = turnsRegistry.getByAiSession(sub.childAiSessionId);
  if (turn?.handle?.interrupt) {
    try {
      void turn.handle.interrupt();
    } catch (e: any) {
      console.error(`[sub-agents] ${id} interrupt failed:`, e?.message ?? e);
    }
    return true;
  }
  subStore.setStatus(id, "cancelled");
  return true;
}

async function runChild(
  subId: string,
  childAiSessionId: string,
  prompt: string,
  taskId?: string,
): Promise<void> {
  const child = aiStore.read(childAiSessionId);
  if (!child) {
    subStore.setStatus(subId, "failed");
    return;
  }
  subStore.setStatus(subId, "running");

  // Resolve where the sub-agent's live preview bubble + final reply land.
  // Direct-bound child chat wins (that's where the user is steering it);
  // otherwise fall back to the parent's chat so the parent group sees
  // its delegated work.
  const subRow = subStore.read(subId);
  const parent = subRow ? aiStore.read(subRow.parentAiSessionId) : null;
  const destChatId =
    child.channels?.telegram?.chatId ?? parent?.channels?.telegram?.chatId;
  const destThreadId =
    child.channels?.telegram?.threadId ?? parent?.channels?.telegram?.threadId;

  // Open a status bubble in the destination chat and register an
  // ActiveTurn for the child AiSession so PreToolUse / PostToolUse hooks
  // routed by the child's claude session_id land on THIS bubble (not on
  // the parent's, which has already finished its launch turn by now).
  const status = destChatId != null
    ? await telegramChannel.openSubAgentBubble(destChatId)
    : null;
  // Lead with a header so the user can tell at a glance which sub-agent
  // this bubble belongs to — useful when several run in parallel and the
  // chat has multiple "🤔 thinking…" bubbles editing in place.
  if (status && subRow) {
    status.push(
      `🤖 sub-agent ${subRow.id.slice(0, 8)}${subRow.label ? ` (${subRow.label})` : ""} · ${child.provider}`,
    );
  }
  const turn: turnsRegistry.ActiveTurn | null = status && destChatId != null ? {
    aiSessionId: child.id,
    providerSessionId: undefined, // bound below on first session_id event
    chatId: destChatId,
    threadId: destThreadId,
    status,
    trace: {
      source: "agent",
      label: subRow?.label,
      prompt,
      startedAt: Date.now(),
      events: [],
    },
    startedAt: Date.now(),
    sentImagePaths: new Set<string>(),
  } : null;
  if (turn) turnsRegistry.register(turn);

  const handle = getProvider(child.provider).run({
    prompt,
    aiSessionId: child.id,
    cwd: child.cwd,
    yolo: true,
    effort: child.reasoningEffort,
  });
  // Stash the run handle on the ActiveTurn so /sub-agents/:id/cancel can
  // resolve child aiSessionId → turn → handle.interrupt().
  if (turn) turn.handle = handle;
  subStore.touchActivity(subId);

  // Single-consumer drain: bind providerSessionId on the first session_id
  // event, render image events, log error events. Tool events come via
  // hooks → dispatch finds the ActiveTurn we just registered → drives the
  // bubble. If we tried to drain in parallel with runToCompletion the
  // events stream would be split between two consumers and bind events
  // could be missed.
  for await (const ev of handle.events) {
    subStore.touchActivity(subId);
    if (taskId) {
      try { taskStore.touchActivity(taskId); } catch { /* best effort */ }
    }
    if (ev.type === "session_id") {
      subStore.bindProviderSession(subId, ev.sessionId);
      if (taskId) {
        try { taskStore.bindProviderSession(taskId, ev.sessionId); } catch { /* best effort */ }
      }
      if (turn) turnsRegistry.bindProviderSession(turn.aiSessionId, ev.sessionId);
    } else if (ev.type === "image" && destChatId != null) {
      try {
        const { readFileSync } = await import("node:fs");
        const { basename } = await import("node:path");
        let bytes: Buffer | null = null;
        let filename = "image.png";
        if (ev.path) {
          bytes = readFileSync(ev.path);
          filename = basename(ev.path);
        } else if (ev.bytes) {
          bytes = Buffer.from(ev.bytes, "base64");
        }
        if (bytes) {
          await telegramChannel.sendPhotoToChat({
            chatId: destChatId,
            bytes,
            filename,
            mimeType: ev.mimeType ?? "image/png",
            threadId: destThreadId,
          });
        }
      } catch (e) {
        console.error(`[sub-agents] ${subId} sendPhoto failed:`, e);
      }
    } else if (ev.type === "error") {
      if (status) status.push(`❌ ${ev.message}`);
    }
  }
  const meta = await handle.done;

  // Map the run's terminal status to our SubAgent row.
  if (meta.status === "completed") {
    subStore.setStatus(subId, "completed");
  } else if (meta.status === "failed") {
    subStore.setStatus(subId, "failed");
  } else {
    subStore.setStatus(subId, "cancelled");
  }
  console.log(
    `[subagents] terminal sub=${subId.slice(0, 8)} task=${taskId?.slice(0, 8) ?? "-"} status=${meta.status}${meta.error ? ` error="${String(meta.error).slice(0, 100)}"` : ""}`,
  );
  const resultText =
    (meta.output ?? "").trim() ||
    (meta.error ? `Run failed: ${meta.error}` : "(no output)");
  if (meta.output) subStore.setResultSummary(subId, meta.output);

  // Mirror terminal status onto the linked task row, if any. The
  // supervisor reads this back to decide whether to merge, retry, or
  // escalate. Worktree merge is not attempted here — the supervisor owns
  // that decision and may flip the task to merge_failed via the API.
  if (taskId) {
    try {
      if (meta.status === "completed") {
        taskStore.complete(taskId, meta.output ?? undefined);
      } else if (meta.status === "failed") {
        taskStore.fail(taskId, meta.error ?? "run failed");
      } else {
        taskStore.cancel(taskId, "run cancelled");
      }
    } catch (e: unknown) {
      console.error(
        `[sub-agents] task ${taskId} terminal update failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Finalize the sub-agent's own bubble with a header + the full reply
  // so the user can scroll it back later. Best-effort — don't let a
  // telegram failure block parent injection below.
  if (status && subRow) {
    const header = `🤖 sub-agent ${subRow.id.slice(0, 8)}${subRow.label ? ` (${subRow.label})` : ""} · ${child.provider}: ${meta.status}`;
    try {
      await status.finalize(`${header}\n\n${resultText}`);
    } catch (e: any) {
      console.error(`[sub-agents] ${subId} finalize failed:`, e?.message ?? e);
    }
  }
  if (turn) turnsRegistry.remove(turn);

  // Inject the result back into the parent session as the next turn so
  // the parent agent can reason about the sub-agent's output without
  // having to poll. Same pattern jobs/resume use. Skipped when the
  // linked task has notify_supervisor=0 — for fire-and-forget work
  // where the supervisor wants to poll /subagents later instead of
  // being woken on completion.
  let suppressInject = false;
  if (taskId) {
    const t = taskStore.read(taskId);
    if (t && t.notifySupervisor === false) suppressInject = true;
  }
  if (parent && !suppressInject) {
    const prefix = `[sub-agent ${subId} provider=${child.provider} status=${meta.status}${
      subRow?.label ? ` label="${subRow.label}"` : ""
    }]`;
    const injected = [
      prefix,
      "",
      resultText,
      "",
      "Continue from where you left off based on this result.",
    ].join("\n");
    try {
      await injectTurnOnSession(parent, injected, { resumeSession: true });
    } catch (e: any) {
      console.error(`[sub-agents] ${subId} parent inject failed:`, e?.message ?? e);
    }
  }
}
