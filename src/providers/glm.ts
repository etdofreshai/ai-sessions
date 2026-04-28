import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeClaudeFlavoredProvider } from "./claude.js";

// GLM is Claude Code pointed at z.ai's Anthropic-compatible endpoint via env
// vars supplied by a settings file. The same `claude` binary handles
// everything; we just hand the SDK an extra settings file path and let
// claude-code apply the file's `env` block (and hooks/statusLine) natively.
//
// Settings file shape (~/.claude/settings-glm.json):
//   { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "...", ... } }

function settingsPath(): string {
  return process.env.AI_SESSIONS_GLM_SETTINGS
    || join(homedir(), ".claude", "settings-glm.json");
}

function resolveSettings(): string | null {
  const p = settingsPath();
  if (existsSync(p)) return p;
  console.error(`[glm] settings file not found at ${p} — falling back to default Claude env`);
  return null;
}

export const glmProvider = makeClaudeFlavoredProvider({
  name: "glm",
  settingsPath: resolveSettings,
  isAvailable: () => existsSync(settingsPath()),
});
