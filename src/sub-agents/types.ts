export type SubAgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

// Parent ↔ child AiSession relationship. The child's full state lives in
// ai_sessions (childAiSessionId points at it); this row only tracks the
// link and the run lifecycle so hooks can route back and the parent's UI
// can show a preview bubble.
export interface SubAgent {
  id: string;
  parentAiSessionId: string;
  childAiSessionId: string;
  provider: string;
  // Inner-harness session id, populated once the child's first run starts
  // and bound by routeToSession's drain loop (same path as ActiveTurn).
  providerSessionId?: string;
  // For backgrounded launches, the bash/task id the inner harness assigned
  // (separate from providerSessionId — multiple sub-agents can share a
  // session_id in some sub-agent tool flows).
  providerAgentId?: string;
  label?: string;
  status: SubAgentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  // Bumped on every event observed from the child run — used to compute a
  // stall heuristic ("running but silent for N minutes") without crawling
  // run_events.
  lastActivityAt?: string;
  // Short (≤ ~240 chars) summary of the final reply for status displays.
  // The full transcript stays in the child's session jsonl.
  resultSummary?: string;
}
