import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import { db } from "../db/index.js";
import type { CronJob } from "./types.js";

interface Row {
  name: string;
  cron: string;
  timezone: string | null;
  target_json: string;
  enabled: number;
  missed_policy: string;
  next_run_at: string;
  last_run_at: string | null;
  last_started_at: string | null;
  last_error: string | null;
  created_at: string;
}

function fromRow(r: Row): CronJob {
  return {
    name: r.name,
    cron: r.cron,
    timezone: r.timezone ?? undefined,
    target: JSON.parse(r.target_json),
    enabled: Boolean(r.enabled),
    missedPolicy: r.missed_policy as CronJob["missedPolicy"],
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastStartedAt: r.last_started_at ?? undefined,
    lastError: r.last_error ?? undefined,
    createdAt: r.created_at,
  };
}

function toRow(j: CronJob): Row {
  return {
    name: j.name,
    cron: j.cron,
    timezone: j.timezone ?? null,
    target_json: JSON.stringify(j.target),
    enabled: j.enabled ? 1 : 0,
    missed_policy: j.missedPolicy,
    next_run_at: j.nextRunAt,
    last_run_at: j.lastRunAt ?? null,
    last_started_at: j.lastStartedAt ?? null,
    last_error: j.lastError ?? null,
    created_at: j.createdAt,
  };
}

const COLUMNS = [
  "name", "cron", "timezone", "target_json", "enabled", "missed_policy",
  "next_run_at", "last_run_at", "last_started_at", "last_error", "created_at",
];
const PLACEHOLDERS = COLUMNS.map((c) => `@${c}`).join(", ");
const ASSIGNMENTS = COLUMNS.filter((c) => c !== "name").map((c) => `${c} = @${c}`).join(", ");

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid cron name: ${name} (use [a-zA-Z0-9_-])`);
  }
}

export function list(): CronJob[] {
  importLegacyJsonsOnce();
  const rows = db().prepare(`SELECT * FROM crons`).all() as Row[];
  return rows.map(fromRow);
}

export function read(name: string): CronJob | null {
  importLegacyJsonsOnce();
  validateName(name);
  const row = db().prepare(`SELECT * FROM crons WHERE name = ?`).get(name) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function write(job: CronJob): void {
  importLegacyJsonsOnce();
  validateName(job.name);
  db().prepare(
    `INSERT INTO crons (${COLUMNS.join(", ")})
     VALUES (${PLACEHOLDERS})
     ON CONFLICT(name) DO UPDATE SET ${ASSIGNMENTS}`,
  ).run(toRow(job));
}

export function remove(name: string): boolean {
  importLegacyJsonsOnce();
  validateName(name);
  const info = db().prepare(`DELETE FROM crons WHERE name = ?`).run(name);
  return info.changes > 0;
}

let imported = false;
function importLegacyJsonsOnce(): void {
  if (imported) return;
  imported = true;
  const legacy = join(dataDir(), "crons");
  if (!existsSync(legacy)) return;
  ensureDir(legacy);
  const files = readdirSync(legacy).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;
  let count = 0;
  const insert = db().prepare(
    `INSERT OR IGNORE INTO crons (${COLUMNS.join(", ")}) VALUES (${PLACEHOLDERS})`,
  );
  const tx = db().transaction((rows: Row[]) => {
    for (const r of rows) insert.run(r);
  });
  const rows: Row[] = [];
  for (const f of files) {
    try {
      const job = JSON.parse(readFileSync(join(legacy, f), "utf8")) as CronJob;
      if (job?.name) {
        rows.push(toRow(job));
        count++;
      }
    } catch {
      /* skip */
    }
  }
  tx(rows);
  const backup = `${legacy}.imported.${Date.now()}`;
  try {
    renameSync(legacy, backup);
    console.error(`[db] imported ${count} crons from ${legacy}; backed up to ${backup}`);
  } catch (e: any) {
    console.error(`[db] imported ${count} crons but couldn't rename backup: ${e?.message ?? e}`);
  }
}
