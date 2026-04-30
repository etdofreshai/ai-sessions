import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import type { CronJob } from "./types.js";

// Crons live under dataDir (per-machine state), not workspaceDir (shared
// across machines via git sync). Otherwise scheduled jobs configured on one
// machine would silently fire on every other machine that pulls the workspace.
function cronsDir(): string {
  return ensureDir(join(dataDir(), "crons"));
}

function pathFor(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid cron name: ${name} (use [a-zA-Z0-9_-])`);
  }
  return join(cronsDir(), `${name}.json`);
}

export function list(): CronJob[] {
  const dir = cronsDir();
  const out: CronJob[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function read(name: string): CronJob | null {
  const p = pathFor(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

// Atomic write via tmp + rename so a concurrent reader never sees partial JSON.
export function write(job: CronJob): void {
  const p = pathFor(job.name);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, p);
}

export function remove(name: string): boolean {
  const p = pathFor(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
