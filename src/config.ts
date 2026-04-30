import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir } from "./fsutil.js";

// Best-effort .env load (Node >=20.6). The feature-detect itself shouldn't
// throw; only the actual load can fail (missing file, perms), so the catch
// is scoped tightly so a real permission issue doesn't masquerade as
// "old node".
// @ts-ignore — loadEnvFile is recent
if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  try {
    // @ts-ignore
    process.loadEnvFile();
  } catch (e: any) {
    console.error(`[config] .env load failed: ${e?.message ?? e}`);
  }
}

export function dataDir(): string {
  return ensureDir(resolve(process.env.AI_SESSIONS_DATA_DIR || process.cwd()));
}

export function port(): number {
  const v = parseInt(process.env.AI_SESSIONS_PORT ?? "", 10);
  return Number.isFinite(v) ? v : 7878;
}

export function defaultAgent(): string {
  return process.env.AI_SESSIONS_DEFAULT_AGENT || "claude";
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
const EFFORT_VALUES: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (EFFORT_VALUES as string[]).includes(v);
}
export function defaultReasoningEffort(): ReasoningEffort {
  const v = process.env.AI_SESSIONS_DEFAULT_EFFORT?.toLowerCase();
  return isReasoningEffort(v) ? v : "low";
}

// The directory agents should run inside by default (mainly for
// channel-driven runs where the caller has no cwd of its own).
//
// Resolution order:
//   1. AI_SESSIONS_WORKSPACE_DIR — absolute or relative path; used verbatim.
//   2. <dataDir>/<AI_SESSIONS_WORKSPACE_NAME> — defaults to "workspaces".
//
// Auto-created on first access.
export function workspaceDir(): string {
  const explicit = process.env.AI_SESSIONS_WORKSPACE_DIR;
  if (explicit) return ensureDir(resolve(explicit));
  const name = process.env.AI_SESSIONS_WORKSPACE_NAME || "workspace";
  return ensureDir(join(dataDir(), name));
}
