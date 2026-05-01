import type { StatusBlock } from "../channels/telegram-status.js";
import type { TraceRecord } from "../channels/telegram-utils.js";

// Per-active-turn UI state. Created when routeToSession kicks off a turn,
// looked up by hook handlers as PreToolUse/PostToolUse events arrive, and
// finalized when the SDK completes (or the Stop hook fires, whichever).
export interface ActiveTurn {
  aiSessionId: string;
  // Inner-harness session id (claude/codex). Often known up front when
  // resuming; for fresh sessions we backfill on the first hook event.
  providerSessionId?: string;
  chatId: number;
  threadId?: number;
  status: StatusBlock;
  trace: TraceRecord;
  startedAt: number;
  // Set of image-attachment paths already sent to the chat — prevents
  // duplicate sendPhoto when multiple events reference the same path.
  sentImagePaths: Set<string>;
}

const byAiSession = new Map<string, ActiveTurn>();
const byProviderSession = new Map<string, ActiveTurn>();

export function register(turn: ActiveTurn): void {
  byAiSession.set(turn.aiSessionId, turn);
  if (turn.providerSessionId) byProviderSession.set(turn.providerSessionId, turn);
}

export function bindProviderSession(aiSessionId: string, providerSessionId: string): void {
  const turn = byAiSession.get(aiSessionId);
  if (!turn) return;
  turn.providerSessionId = providerSessionId;
  byProviderSession.set(providerSessionId, turn);
}

export function getByProviderSession(providerSessionId: string): ActiveTurn | undefined {
  return byProviderSession.get(providerSessionId);
}

export function getByAiSession(aiSessionId: string): ActiveTurn | undefined {
  return byAiSession.get(aiSessionId);
}

export function remove(turn: ActiveTurn): void {
  byAiSession.delete(turn.aiSessionId);
  if (turn.providerSessionId) byProviderSession.delete(turn.providerSessionId);
}

// Diagnostic: short representation of which sessions are currently registered.
// Used by the hook dispatcher to log "no active turn for X (registered: …)"
// when a bubble fails to update.
export function debugSnapshot(): string[] {
  return [...byAiSession.values()].map((t) =>
    `ai=${t.aiSessionId.slice(0, 8)} provider=${t.providerSessionId?.slice(0, 8) ?? "(none)"}`,
  );
}
