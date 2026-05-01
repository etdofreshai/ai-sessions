import * as jobsStore from "./store.js";
import type { Job } from "./types.js";

// Compact "Outstanding jobs" section to append to the system prompt at the
// start of every turn. Lists pending and running jobs for the AiSession so
// the agent doesn't lose track of what it dispatched across many turns.
//
// Returns "" when the session has nothing outstanding — caller can skip
// adding any header in that case.
export function outstandingJobsSection(aiSessionId: string | undefined): string {
  if (!aiSessionId) return "";
  const jobs = jobsStore.listOutstandingForSession(aiSessionId);
  if (jobs.length === 0) return "";

  const lines: string[] = [];
  lines.push("## Outstanding background jobs");
  lines.push("");
  lines.push(
    `You currently have ${jobs.length} background job${jobs.length === 1 ? "" : "s"} ` +
      `dispatched on this session. Their results will arrive automatically as future turns ` +
      `prefixed with "[job <id> ...]" — you don't need to poll them or remind the user. ` +
      `Use \`ais jobs ls\` if you want full detail.`,
  );
  lines.push("");
  for (const j of jobs) {
    lines.push(`- ${describe(j)}`);
  }
  return lines.join("\n");
}

function describe(j: Job): string {
  const age = formatAge(Date.now() - new Date(j.startedAt ?? j.createdAt).getTime());
  const head = `${j.status.padEnd(7)} ${j.id.slice(0, 8)}`;
  const label = j.label ? `  — ${j.label}` : "";
  const cmd =
    j.payload.kind === "bash"
      ? `  bash: ${truncate(j.payload.cmd, 80)}`
      : `  ${j.payload.kind}`;
  return `${head} (${age})${label}${cmd}`;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / (60 * 60_000)).toFixed(1)}h`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
