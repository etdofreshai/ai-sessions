import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import type { AiSession } from "../ai-sessions/types.js";

interface Entry {
  child: ChildProcess;
  startedAt: number;
  logPath: string;
}

const registry = new Map<string, Entry>();

export function isRunning(aiSessionId: string): boolean {
  const e = registry.get(aiSessionId);
  return !!e && e.child.exitCode == null && e.child.signalCode == null;
}

export interface StartResult {
  ok: boolean;
  pid?: number;
  logPath?: string;
  error?: string;
}

// Spawns `claude` in remote-control mode for an AiSession. Empty prompt;
// the process stays alive and pulls events from claude.ai. Returns the PID
// and the log file we redirect stdout/stderr to so the caller can surface
// it if anything goes wrong.
export function start(ai: AiSession): StartResult {
  if (ai.provider !== "claude") {
    return { ok: false, error: "remote-control only supported for claude sessions" };
  }
  if (!ai.sessionId) {
    return { ok: false, error: "session has no claude session id yet — send a message first" };
  }
  if (isRunning(ai.id)) {
    return { ok: true, pid: registry.get(ai.id)!.child.pid, logPath: registry.get(ai.id)!.logPath };
  }
  const logDir = join(dataDir(), "remote-control");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${ai.id}.log`);
  const out = createWriteStream(logPath, { flags: "a" });
  const args = [
    "--remote-control",
    "--dangerously-skip-permissions",
    "--resume",
    ai.sessionId,
  ];
  let child: ChildProcess;
  try {
    child = spawn("claude", args, {
      cwd: ai.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false on purpose — child dies when parent exits, even on
      // hard kill, because we don't break the process group.
      detached: false,
      shell: false,
    });
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  child.on("exit", (code, signal) => {
    out.end(`\n[exit code=${code} signal=${signal}]\n`);
    const cur = registry.get(ai.id);
    if (cur && cur.child === child) registry.delete(ai.id);
  });
  child.on("error", (err) => {
    out.write(`\n[spawn error] ${err.message}\n`);
  });
  registry.set(ai.id, { child, startedAt: Date.now(), logPath });
  return { ok: true, pid: child.pid, logPath };
}

export function stop(aiSessionId: string): boolean {
  const e = registry.get(aiSessionId);
  if (!e) return false;
  try {
    e.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  registry.delete(aiSessionId);
  return true;
}

export function stopAll(): void {
  for (const [, e] of registry) {
    try {
      e.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  registry.clear();
}

// Kill children if this server process exits. Best-effort.
let installedShutdown = false;
export function installShutdownHook(): void {
  if (installedShutdown) return;
  installedShutdown = true;
  const onExit = () => stopAll();
  process.on("exit", onExit);
  process.on("SIGINT", () => {
    stopAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopAll();
    process.exit(143);
  });
}
