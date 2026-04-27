import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import type { RunEvent, RunHandle, RunMetadata, RunStatus } from "./types.js";

const live = new Map<string, RunHandle>();

function runsDir(): string {
  const dir = join(dataDir(), "runs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function runPath(runId: string): string {
  return join(runsDir(), `${runId}.jsonl`);
}

export function newRunId(): string {
  return randomUUID();
}

export function persistMeta(meta: RunMetadata): void {
  appendFileSync(runPath(meta.runId), JSON.stringify({ kind: "meta", meta }) + "\n");
}

export function persistEvent(runId: string, event: RunEvent): void {
  appendFileSync(runPath(runId), JSON.stringify({ kind: "event", event }) + "\n");
}

export function setStatus(meta: RunMetadata, status: RunStatus, extras?: Partial<RunMetadata>): void {
  meta.status = status;
  if (extras) Object.assign(meta, extras);
  if (status === "completed" || status === "interrupted" || status === "failed") {
    meta.endedAt = meta.endedAt ?? new Date().toISOString();
  }
  persistMeta(meta);
}

export function register(handle: RunHandle): void {
  live.set(handle.meta.runId, handle);
  // Auto-cleanup from live map on completion.
  handle.done.finally(() => live.delete(handle.meta.runId));
}

export function getLive(runId: string): RunHandle | undefined {
  return live.get(runId);
}

export function loadFromDisk(runId: string): RunMetadata | null {
  const p = runPath(runId);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  let meta: RunMetadata | null = null;
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.kind === "meta") meta = rec.meta;
    } catch {
      // skip
    }
  }
  return meta;
}

export function loadEvents(runId: string): RunEvent[] {
  const p = runPath(runId);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
  const events: RunEvent[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.kind === "event") events.push(rec.event);
    } catch {
      // skip
    }
  }
  return events;
}

export function listRunIds(limit = 100): string[] {
  if (!existsSync(runsDir())) return [];
  const files = readdirSync(runsDir()).filter((f) => f.endsWith(".jsonl"));
  files.sort().reverse();
  return files.slice(0, limit).map((f) => f.replace(/\.jsonl$/, ""));
}
