import * as turns from "../turns/registry.js";
import { formatToolInput } from "../channels/telegram-utils.js";
import * as subStore from "../sub-agents/store.js";

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

  let turn = turns.getByProviderSession(sessionId);
  // Sub-agent label gets prefixed onto bubble lines so the parent chat can
  // tell the child's activity apart from the parent's own. Non-empty only
  // when we resolved this hook through the parent ↔ sub-agents mapping.
  let prefix = "";
  // Bump sub-agent activity timestamp on every observed hook so the stall
  // heuristic in /sub-agents responses stays current — even when the parent
  // turn isn't in the foreground anymore.
  const subForActivity = subStore.findByChildProviderSession(sessionId);
  if (subForActivity) subStore.touchActivity(subForActivity.id);
  if (!turn) {
    // No direct match — maybe this is a sub-agent we spawned through the
    // outer harness. Resolve to the parent's ActiveTurn and prefix lines.
    const sub = subForActivity;
    if (sub) {
      const parentTurn = turns.getByAiSession(sub.parentAiSessionId);
      if (parentTurn) {
        turn = parentTurn;
        prefix = `🤖 sub-agent ${sub.id.slice(0, 8)}${sub.label ? ` (${sub.label})` : ""}: `;
      }
    }
  }
  if (!turn) {
    // Useful when the bubble doesn't update: tells us the hook arrived but
    // we have no active turn registered for that session id. Common causes:
    //   - SDK's claude subprocess invented a new session_id we never bound
    //   - hook arrived after the route turn cleaned up
    //   - hook came from a session ai-sessions didn't start
    //   - sub-agent's parent has no active turn (e.g. parent finished)
    console.error(
      `[hooks] no active turn for ${eventName} session=${sessionId.slice(0, 8)}` +
        ` (registered: ${turns.debugSnapshot().join(", ") || "(none)"})`,
    );
    return;
  }

  switch (eventName) {
    case "PreToolUse":
      handlePreToolUse(turn, payload, prefix);
      return;
    case "PostToolUse":
      handlePostToolUse(turn, payload, prefix);
      return;
    default:
      return;
  }
}

function handlePreToolUse(
  turn: turns.ActiveTurn,
  payload: Record<string, unknown>,
  prefix: string,
): void {
  const toolName = (payload.tool_name as string | undefined) ?? "tool";
  const toolInput = payload.tool_input;
  const inputStr = formatToolInput(toolInput);
  turn.status.push(`${prefix}🔧 ${toolName}${inputStr ? `: ${inputStr}` : ""}`);
  turn.trace.events.push({
    ts: Date.now(),
    type: "tool_use",
    name: prefix ? `sub:${toolName}` : toolName,
    input: toolInput,
  });
}

function handlePostToolUse(
  turn: turns.ActiveTurn,
  payload: Record<string, unknown>,
  prefix: string,
): void {
  const toolName = (payload.tool_name as string | undefined) ?? "tool";
  const toolInput = payload.tool_input;
  const toolOutput = payload.tool_response ?? payload.tool_result;
  turn.status.markLastDone();
  turn.trace.events.push({
    ts: Date.now(),
    type: "tool_result",
    name: prefix ? `sub:${toolName}` : toolName,
    output: toolOutput,
  });
}
