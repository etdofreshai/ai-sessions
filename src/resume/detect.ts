import type { ResumeBgTask } from "../ai-sessions/types.js";

// Pull a background-task launch out of a tool_use + tool_result pair if it
// represents one. Returns null when the call wasn't a backgrounded launch.
//
// Two shapes today:
//   1. Bash with run_in_background:true — tool_result.output is a string:
//        "Command running in background with ID: <id>.
//         Output is being written to: <path>"
//   2. Agent (Task subagent) with run_in_background:true — tool_result.output
//      is an object { status: "async_launched", agentId, outputFile }
export function detectBgLaunch(args: {
  toolName: string;
  toolInput: any;
  toolOutput: unknown;
}): ResumeBgTask | null {
  const { toolName, toolInput, toolOutput } = args;

  if (toolName === "Bash" && toolInput?.run_in_background === true) {
    const text = typeof toolOutput === "string" ? toolOutput : "";
    const m = /running in background with ID:\s*(\S+)[\s\S]*?Output is being written to:\s*(\S+)/i.exec(
      text,
    );
    if (!m) return null;
    return {
      id: m[1],
      outputFile: m[2],
      kind: "bash",
      label:
        typeof toolInput?.description === "string"
          ? String(toolInput.description).slice(0, 80)
          : typeof toolInput?.command === "string"
            ? String(toolInput.command).slice(0, 80)
            : undefined,
      launchedAt: new Date().toISOString(),
    };
  }

  if (toolName === "Agent" && toolInput?.run_in_background === true) {
    const out = (toolOutput ?? {}) as any;
    if (out?.status !== "async_launched" || !out?.agentId || !out?.outputFile) return null;
    return {
      id: String(out.agentId),
      outputFile: String(out.outputFile),
      kind: "agent",
      label:
        typeof toolInput?.description === "string"
          ? String(toolInput.description).slice(0, 80)
          : undefined,
      launchedAt: new Date().toISOString(),
    };
  }

  return null;
}
