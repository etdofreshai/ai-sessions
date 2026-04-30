import * as aiStore from "./store.js";
import type { AiSession } from "./types.js";

export const DEFAULT_WATCH_TTL_MS = 60 * 60 * 1000;

// Parse a TTL token like "30m", "2h", "45s" into milliseconds. Returns null
// when the input doesn't look like a duration (so callers can treat it as a
// non-TTL keyword like "on"/"off").
export function parseTtl(token: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(token.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch ((m[2] ?? "m").toLowerCase()) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    case "d":  return n * 24 * 60 * 60 * 1000;
    default:   return n * 60 * 1000;
  }
}

export function formatTtl(ms: number): string {
  if (ms >= 60 * 60 * 1000 && ms % (60 * 60 * 1000) === 0) return `${ms / 3600000}h`;
  if (ms >= 60 * 1000 && ms % (60 * 1000) === 0) return `${ms / 60000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

// Bump watchUntil forward by watchTtlMs. No-op when:
//   - watch is off (watch !== true)
//   - watch is true but watchTtlMs is unset (indefinite mode — nothing to slide)
// Persists the AiSession when the timestamp moves.
export function slideWatch(ai: AiSession): void {
  if (ai.watch !== true) return;
  if (!ai.watchTtlMs) return;
  ai.watchUntil = new Date(Date.now() + ai.watchTtlMs).toISOString();
  aiStore.write(ai);
}

// True when the session has a finite watch and the deadline has passed.
export function isExpired(ai: AiSession, now = Date.now()): boolean {
  if (ai.watch !== true) return false;
  if (!ai.watchTtlMs || !ai.watchUntil) return false;
  return new Date(ai.watchUntil).getTime() <= now;
}
