import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Best-effort .env load (Node >=20.6). No-op if no file or older Node.
try {
  // @ts-ignore — loadEnvFile is recent
  if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
    // @ts-ignore
    process.loadEnvFile();
  }
} catch {
  /* ignore */
}

export function dataDir(): string {
  const dir = resolve(process.env.AI_SESSIONS_DATA_DIR || process.cwd());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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
  let p: string;
  if (explicit) {
    p = resolve(explicit);
  } else {
    const name = process.env.AI_SESSIONS_WORKSPACE_NAME || "workspace";
    p = join(dataDir(), name);
  }
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}
