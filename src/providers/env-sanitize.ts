// Strip orchestrator-only env vars before handing the environment to a
// spawned agent subprocess. Anything that controls how ai-sessions reaches
// Telegram or its own HTTP server should NOT leak into a subagent — if it
// did, the agent's tool calls could spawn helpers that also try to poll
// the bot token, race for /getUpdates, or rewrite our own state. Keep this
// list short; only add an entry when you've confirmed an agent script
// would misuse it.
const ORCHESTRATOR_ONLY = new Set<string>([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
]);

export function sanitizeSubprocessEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (ORCHESTRATOR_ONLY.has(k)) continue;
    out[k] = v;
  }
  return out;
}
