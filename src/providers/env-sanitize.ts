import { port as defaultPort } from "../config.js";

// Strip orchestrator-only env vars before handing the environment to a
// spawned agent subprocess. Anything that controls how ai-sessions reaches
// Telegram should NOT leak into a subagent — if it did, the agent's tool
// calls could spawn helpers that also try to poll the bot token, race for
// /getUpdates, or rewrite our own state. Keep this list short; only add
// an entry when you've confirmed an agent script would misuse it.
const ORCHESTRATOR_ONLY = new Set<string>([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
]);

export interface SubprocessEnvOptions {
  // Current AiSession id — exposed as AI_SESSION_ID so skills (orchestration,
  // ai-sessions-jobs, afk, ...) can reference $AI_SESSION_ID literally
  // without the agent having to discover its own id.
  aiSessionId?: string;
}

export function sanitizeSubprocessEnv(
  opts: SubprocessEnvOptions = {},
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (ORCHESTRATOR_ONLY.has(k)) continue;
    out[k] = v;
  }
  // Always make the local ai-sessions HTTP API discoverable via curl. Skills
  // default to ${AI_SESSIONS_URL:-http://localhost:7878}; setting it here
  // means subagents in containers / different cwds still reach the right
  // place.
  if (!out.AI_SESSIONS_URL) {
    out.AI_SESSIONS_URL = `http://localhost:${defaultPort()}`;
  }
  if (opts.aiSessionId) {
    out.AI_SESSION_ID = opts.aiSessionId;
  }
  return out;
}
