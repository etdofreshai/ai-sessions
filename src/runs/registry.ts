import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import { db } from "../db/index.js";
import type { RunEvent, RunHandle, RunMetadata, RunStatus } from "./types.js";

const live = new Map<string, RunHandle>();

interface MetaRow {
  run_id: string;
  provider: string;
  session_id: string | null;
  ai_session_id: string | null;
  status: string;
  prompt: string;
  cwd: string | null;
  yolo: number;
  internal: number | null;
  created_at: string;
  ended_at: string | null;
  output: string | null;
  error: string | null;
}

interface EventRow {
  seq: number;
  type: string;
  payload_json: string;
}

function metaFromRow(r: MetaRow): RunMetadata {
  return {
    runId: r.run_id,
    provider: r.provider,
    sessionId: r.session_id ?? undefined,
    aiSessionId: r.ai_session_id ?? undefined,
    status: r.status as RunStatus,
    prompt: r.prompt,
    cwd: r.cwd ?? undefined,
    yolo: Boolean(r.yolo),
    internal: r.internal == null ? undefined : Boolean(r.internal),
    createdAt: r.created_at,
    endedAt: r.ended_at ?? undefined,
    output: r.output ?? undefined,
    error: r.error ?? undefined,
  };
}

const META_COLS = [
  "run_id", "provider", "session_id", "ai_session_id", "status", "prompt",
  "cwd", "yolo", "internal", "created_at", "ended_at", "output", "error",
];
const META_PLACEHOLDERS = META_COLS.map((c) => `@${c}`).join(", ");
const META_ASSIGNMENTS = META_COLS.filter((c) => c !== "run_id")
  .map((c) => `${c} = @${c}`).join(", ");

function metaToParams(m: RunMetadata): Record<string, unknown> {
  return {
    run_id: m.runId,
    provider: m.provider,
    session_id: m.sessionId ?? null,
    ai_session_id: m.aiSessionId ?? null,
    status: m.status,
    prompt: m.prompt,
    cwd: m.cwd ?? null,
    yolo: m.yolo ? 1 : 0,
    internal: m.internal == null ? null : m.internal ? 1 : 0,
    created_at: m.createdAt,
    ended_at: m.endedAt ?? null,
    output: m.output ?? null,
    error: m.error ?? null,
  };
}

export function newRunId(): string {
  return randomUUID();
}

export function persistMeta(meta: RunMetadata): void {
  importLegacyJsonlsOnce();
  db().prepare(
    `INSERT INTO runs (${META_COLS.join(", ")})
     VALUES (${META_PLACEHOLDERS})
     ON CONFLICT(run_id) DO UPDATE SET ${META_ASSIGNMENTS}`,
  ).run(metaToParams(meta));
}

export function persistEvent(runId: string, event: RunEvent): void {
  importLegacyJsonlsOnce();
  // Append-only by seq. We use a subquery to grab the next seq atomically;
  // SQLite serializes writes via WAL so this is safe under concurrent
  // persistEvent calls within one process.
  db().prepare(
    `INSERT INTO run_events (run_id, seq, type, payload_json)
     VALUES (?,
             COALESCE((SELECT MAX(seq) + 1 FROM run_events WHERE run_id = ?), 0),
             ?, ?)`,
  ).run(runId, runId, event.type, JSON.stringify(event));
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
  handle.done.finally(() => live.delete(handle.meta.runId));
}

export function getLive(runId: string): RunHandle | undefined {
  return live.get(runId);
}

export function loadFromDisk(runId: string): RunMetadata | null {
  importLegacyJsonlsOnce();
  const row = db().prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as MetaRow | undefined;
  return row ? metaFromRow(row) : null;
}

export function loadEvents(runId: string): RunEvent[] {
  importLegacyJsonlsOnce();
  const rows = db()
    .prepare(`SELECT seq, type, payload_json FROM run_events WHERE run_id = ? ORDER BY seq`)
    .all(runId) as EventRow[];
  return rows.map((r) => JSON.parse(r.payload_json) as RunEvent);
}

export function listRunIds(limit = 100): string[] {
  importLegacyJsonlsOnce();
  const rows = db()
    .prepare(`SELECT run_id FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as { run_id: string }[];
  return rows.map((r) => r.run_id);
}

let imported = false;
function importLegacyJsonlsOnce(): void {
  if (imported) return;
  imported = true;
  const legacy = join(dataDir(), "runs");
  if (!existsSync(legacy)) return;
  ensureDir(legacy);
  const files = readdirSync(legacy).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return;
  let runCount = 0;
  let evCount = 0;
  const insertMeta = db().prepare(
    `INSERT OR IGNORE INTO runs (${META_COLS.join(", ")}) VALUES (${META_PLACEHOLDERS})`,
  );
  const insertEvent = db().prepare(
    `INSERT OR IGNORE INTO run_events (run_id, seq, type, payload_json) VALUES (?, ?, ?, ?)`,
  );
  const tx = db().transaction((batches: { metas: RunMetadata[]; events: Array<{ runId: string; seq: number; ev: RunEvent }> }) => {
    for (const m of batches.metas) insertMeta.run(metaToParams(m));
    for (const e of batches.events) insertEvent.run(e.runId, e.seq, e.ev.type, JSON.stringify(e.ev));
  });
  const metas: RunMetadata[] = [];
  const events: Array<{ runId: string; seq: number; ev: RunEvent }> = [];
  for (const f of files) {
    const runId = f.replace(/\.jsonl$/, "");
    const lines = readFileSync(join(legacy, f), "utf8").split(/\r?\n/).filter(Boolean);
    let lastMeta: RunMetadata | null = null;
    let seq = 0;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.kind === "meta" && rec.meta) lastMeta = rec.meta as RunMetadata;
        else if (rec.kind === "event" && rec.event) {
          events.push({ runId, seq: seq++, ev: rec.event as RunEvent });
          evCount++;
        }
      } catch {
        /* skip */
      }
    }
    if (lastMeta) {
      metas.push(lastMeta);
      runCount++;
    }
  }
  tx({ metas, events });
  const backup = `${legacy}.imported.${Date.now()}`;
  try {
    renameSync(legacy, backup);
    console.error(`[db] imported ${runCount} runs (${evCount} events) from ${legacy}; backed up to ${backup}`);
  } catch (e: any) {
    console.error(`[db] imported ${runCount} runs but couldn't rename backup: ${e?.message ?? e}`);
  }
}
