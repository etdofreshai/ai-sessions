import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeClaudeFlavoredProvider } from "./claude.js";

// GLM is Claude Code pointed at z.ai's Anthropic-compatible endpoint via env
// vars supplied by a settings file. We do two things in parallel:
//   1. Hand the SDK the settings file path so claude-code loads it as an
//      extra settings source (gets hooks/statusLine etc.).
//   2. Parse the file's `env` block ourselves and inject those vars into the
//      spawned process — the SDK's `settings` option doesn't reliably apply
//      env blocks at process-spawn time, so this guarantees they hit.
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

function loadEnvBlock(): Record<string, string> | null {
  const p = settingsPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const env = raw?.env;
    if (!env || typeof env !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (e: any) {
    console.error(`[glm] failed to parse ${p}: ${e?.message ?? e}`);
    return null;
  }
}

export const glmProvider = makeClaudeFlavoredProvider({
  name: "glm",
  settingsPath: resolveSettings,
  envOverlay: loadEnvBlock,
  isAvailable: () => existsSync(settingsPath()),
});
