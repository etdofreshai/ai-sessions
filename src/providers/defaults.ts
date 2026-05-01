import { db } from "../db/index.js";
import {
  defaultReasoningEffort,
  isReasoningEffort,
  type ReasoningEffort,
} from "../config.js";

// Resolve the reasoning effort for a new run on this provider when neither
// the call site nor the AiSession itself has one set. Lookup order:
//   1. provider_defaults.default_effort (set via /effort default <level>)
//   2. AI_SESSIONS_DEFAULT_EFFORT env (defaultReasoningEffort)
//   3. "low" (config.ts fallback)
export function resolveProviderEffort(provider: string): ReasoningEffort {
  const row = db()
    .prepare(`SELECT default_effort FROM provider_defaults WHERE provider = ?`)
    .get(provider) as { default_effort: string | null } | undefined;
  if (row?.default_effort && isReasoningEffort(row.default_effort)) {
    return row.default_effort;
  }
  return defaultReasoningEffort();
}

// Persist a provider-level default. Returns the value that was written.
export function setProviderDefaultEffort(
  provider: string,
  effort: ReasoningEffort,
): ReasoningEffort {
  db().prepare(
    `INSERT INTO provider_defaults (provider, default_effort)
     VALUES (?, ?)
     ON CONFLICT(provider) DO UPDATE SET default_effort = excluded.default_effort`,
  ).run(provider, effort);
  return effort;
}

// Read-only — used by /effort to show the fall-through chain explicitly.
export function getProviderDefaultEffort(provider: string): ReasoningEffort | null {
  const row = db()
    .prepare(`SELECT default_effort FROM provider_defaults WHERE provider = ?`)
    .get(provider) as { default_effort: string | null } | undefined;
  return row?.default_effort && isReasoningEffort(row.default_effort) ? row.default_effort : null;
}
