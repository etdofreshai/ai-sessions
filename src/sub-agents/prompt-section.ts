import * as subStore from "./store.js";

// System-prompt addendum that tells inner agents to delegate via the outer
// harness instead of their built-in sub-agent tooling. Two cases:
//
//   - This AiSession IS a sub-agent (parent linkage exists in sub_agents) →
//     refuse to spawn further sub-agents (we'd reject the CLI anyway, but
//     surfacing the rule to the model saves a wasted attempt).
//   - This AiSession is at the top → instruct it to prefer
//     `ais sub-agents start ...` for delegated work, and to use its
//     internal Task tool only when the outer-harness path is unavailable.
//
// Refreshed every turn from the DB so a session that becomes a child later
// (e.g. via direct DB manipulation) gets the right rule on its next turn.
export function subAgentPolicySection(aiSessionId: string | undefined): string {
  if (!aiSessionId) return "";
  const isChild = subStore.isChild(aiSessionId);
  const lines: string[] = [];
  lines.push("## Sub-agent policy");
  lines.push("");
  if (isChild) {
    lines.push(
      "This session is a SUB-AGENT spawned by another AiSession. " +
        "You may NOT spawn sub-agents of your own — the outer harness enforces " +
        "one level of nesting. If you need parallel delegated work, finish " +
        "what you were asked to do and let the parent decide.",
    );
  } else {
    const outstanding = subStore.listOutstandingForParent(aiSessionId);
    lines.push(
      "When you need to delegate a chunk of work to a fresh agent process, " +
        "prefer `ais sub-agents start <provider> --parent <id> --prompt ...` " +
        "(see the `orchestration` skill) over your built-in `Task` " +
        "tool. The outer harness tracks the parent ↔ child relationship, " +
        "routes the child's hooks back to this chat as a preview bubble, " +
        "and posts the final reply automatically — your `Task` tool can't " +
        "do those.",
    );
    if (outstanding.length > 0) {
      lines.push("");
      lines.push(
        `You currently have ${outstanding.length} sub-agent${outstanding.length === 1 ? "" : "s"} ` +
          `running. Their results will land here automatically as ` +
          `🤖 sub-agent <id> messages — don't poll them.`,
      );
      for (const s of outstanding) {
        lines.push(`- ${s.status.padEnd(7)} ${s.id.slice(0, 8)} ${s.provider}${s.label ? `  — ${s.label}` : ""}`);
      }
    }
  }
  return lines.join("\n");
}
