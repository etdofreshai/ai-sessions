import * as turns from "../turns/registry.js";
import { detectBgLaunch } from "../resume/detect.js";
import { recordPendingTask } from "../resume/state.js";
import { formatToolInput } from "../channels/telegram-utils.js";

// Drive the in-flight chat UI from inner-harness hook events. Called by
// the /hooks/{harness} endpoint after the event has been persisted.
//
// We only act on hooks that map onto an ActiveTurn we created in
// routeToSession — turns from external claude/codex processes are ignored
// here (the existing `watch` mechanism still mirrors those).
//
// PreToolUse → status.push("🔧 ...") and remember the tool input so a
// matching PostToolUse can mark it done and inspect the result.
// PostToolUse → flip to "✓", append to the trace, capture bg-task launches.
// Stop / SubagentStop → no-op for now: routeToSession finalizes the bubble
// itself when the SDK promise resolves with the final output.
// Notification → not yet wired (will become the Telegram approval-gate path).
export function dispatchHook(args: {
  harness: "claude" | "codex";
  payload: Record<string, unknown>;
}): void {
  const { payload } = args;
  const eventName =
    (payload.hook_event_name as string | undefined) ??
    (payload.event_name as string | undefined);
  const sessionId = payload.session_id as string | undefined;
  if (!sessionId || !eventName) return;

  const turn = turns.getByProviderSession(sessionId);
  if (!turn) {
    // Useful when the bubble doesn't update: tells us the hook arrived but
    // we have no active turn registered for that session id. Common causes:
    //   - SDK's claude subprocess invented a new session_id we never bound
    //   - hook arrived after the route turn cleaned up
    //   - hook came from a session ai-sessions didn't start
    console.error(
      `[hooks] no active turn for ${eventName} session=${sessionId.slice(0, 8)}` +
        ` (registered: ${turns.debugSnapshot().join(", ") || "(none)"})`,
    );
    return;
  }

  switch (eventName) {
    case "PreToolUse":
      handlePreToolUse(turn, payload);
      return;
    case "PostToolUse":
      handlePostToolUse(turn, payload);
      return;
    default:
      return;
  }
}

function handlePreToolUse(
  turn: turns.ActiveTurn,
  payload: Record<string, unknown>,
): void {
  const toolName = (payload.tool_name as string | undefined) ?? "tool";
  const toolInput = payload.tool_input;
  const inputStr = formatToolInput(toolInput);
  turn.status.push(`🔧 ${toolName}${inputStr ? `: ${inputStr}` : ""}`);
  turn.trace.events.push({
    ts: Date.now(),
    type: "tool_use",
    name: toolName,
    input: toolInput,
  });
}

function handlePostToolUse(
  turn: turns.ActiveTurn,
  payload: Record<string, unknown>,
): void {
  const toolName = (payload.tool_name as string | undefined) ?? "tool";
  const toolInput = payload.tool_input;
  const toolOutput = payload.tool_response ?? payload.tool_result;
  turn.status.markLastDone();
  turn.trace.events.push({
    ts: Date.now(),
    type: "tool_result",
    name: toolName,
    output: toolOutput,
  });

  // Capture backgrounded launches so the resume poller can pick up the
  // result when the bg task finishes. The detector already knows both
  // Bash(run_in_background:true) and Agent(run_in_background:true) shapes.
  try {
    const bgTask = detectBgLaunch({
      toolName,
      toolInput,
      toolOutput,
    });
    if (bgTask) recordPendingTask(turn.aiSessionId, bgTask);
  } catch (e) {
    console.error("[hooks] bg-task capture failed:", e);
  }
}
