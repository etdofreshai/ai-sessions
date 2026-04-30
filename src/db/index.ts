import Database from "better-sqlite3";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { migrations } from "./migrations.js";

let cached: Database.Database | null = null;

// Lazy connection — only opens once, on first call. The store modules call
// db() inside each operation rather than at import time so test setups and
// CLI tools that don't need persistence can avoid touching the filesystem.
export function db(): Database.Database {
  if (cached) return cached;
  const path = join(dataDir(), "ai-sessions.sqlite");
  const conn = new Database(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("synchronous = NORMAL");
  runMigrations(conn);
  cached = conn;
  return conn;
}

// Schema version is stored in PRAGMA user_version. Each migration in the
// migrations array corresponds to bumping that number to its 1-based index.
// Idempotent — re-running on an up-to-date db is a no-op.
function runMigrations(conn: Database.Database): void {
  const cur = (conn.pragma("user_version", { simple: true }) as number) ?? 0;
  if (cur >= migrations.length) return;
  conn.transaction(() => {
    for (let i = cur; i < migrations.length; i++) {
      conn.exec(migrations[i]);
    }
    conn.pragma(`user_version = ${migrations.length}`);
  })();
  console.error(`[db] migrated ${cur} -> ${migrations.length}`);
}

// For tests / shutdown only.
export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
