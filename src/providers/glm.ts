import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeClaudeFlavoredProvider } from "./claude.js";

// GLM is Claude Code pointed at z.ai's Anthropic-compatible endpoint via env
// vars. The same `claude` binary handles everything; we just inject the
// auth + base-URL + model overrides at run time.
//
// The settings live at ~/.claude/settings-glm.json with shape:
//   { "env": { "ANTHROPIC_BASE_URL": "...", "ANTHROPIC_AUTH_TOKEN": "...", ... } }

function settingsPath(): string {
  return process.env.AI_SESSIONS_GLM_SETTINGS
    || join(homedir(), ".claude", "settings-glm.json");
}

function loadGlmEnv(): Record<string, string> | null {
  const path = settingsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const env = raw?.env;
    if (!env || typeof env !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export const glmProvider = makeClaudeFlavoredProvider({
  name: "glm",
  envOverlay: loadGlmEnv,
  isAvailable: () => existsSync(settingsPath()),
});
