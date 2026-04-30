import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import { db } from "../db/index.js";
import type { UsageSnapshot } from "./types.js";

export function read(provider: string): UsageSnapshot | null {
  importLegacyJsonsOnce();
  const row = db()
    .prepare(`SELECT snapshot_json FROM usage_snapshots WHERE provider = ?`)
    .get(provider) as { snapshot_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.snapshot_json);
  } catch {
    return null;
  }
}

export function write(snap: UsageSnapshot): void {
  importLegacyJsonsOnce();
  db().prepare(
    `INSERT INTO usage_snapshots (provider, snapshot_json, observed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       snapshot_json = excluded.snapshot_json,
       observed_at = excluded.observed_at`,
  ).run(snap.provider, JSON.stringify(snap), snap.observedAt);
}

let imported = false;
function importLegacyJsonsOnce(): void {
  if (imported) return;
  imported = true;
  const legacy = join(dataDir(), "usage");
  if (!existsSync(legacy)) return;
  ensureDir(legacy);
  const files = readdirSync(legacy).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;
  let count = 0;
  const insert = db().prepare(
    `INSERT OR IGNORE INTO usage_snapshots (provider, snapshot_json, observed_at) VALUES (?, ?, ?)`,
  );
  const tx = db().transaction((rows: UsageSnapshot[]) => {
    for (const r of rows) insert.run(r.provider, JSON.stringify(r), r.observedAt);
  });
  const snaps: UsageSnapshot[] = [];
  for (const f of files) {
    try {
      const snap = JSON.parse(readFileSync(join(legacy, f), "utf8")) as UsageSnapshot;
      if (snap?.provider && snap?.observedAt) {
        snaps.push(snap);
        count++;
      }
    } catch {
      /* skip */
    }
  }
  tx(snaps);
  const backup = `${legacy}.imported.${Date.now()}`;
  try {
    renameSync(legacy, backup);
    console.error(`[db] imported ${count} usage snapshots from ${legacy}; backed up to ${backup}`);
  } catch (e: any) {
    console.error(`[db] imported ${count} usage snapshots but couldn't rename backup: ${e?.message ?? e}`);
  }
}
