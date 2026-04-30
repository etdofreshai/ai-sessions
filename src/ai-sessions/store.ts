import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import { db } from "../db/index.js";
import type { AiSession, ResumeBgTask, SessionChannelBindings } from "./types.js";

export function newAiSessionId(): string {
  return randomUUID();
}

// Two-way mapper between the AiSession TS shape and SQL row shape. JSON-blob
// columns hold sub-structures we don't query inside SQL (channels +
// resumePendingTasks).
interface Row {
  id: string;
  name: string | null;
  provider: string;
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  reasoning_effort: string | null;
  channels_json: string | null;
  watch: number | null;
  watch_started_at: string | null;
  resume: number | null;
  resume_started_at: string | null;
  resume_until: string | null;
  resume_pending_tasks_json: string | null;
  last_bot_message_at: string | null;
  last_bot_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: Row): AiSession {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    sessionId: r.session_id ?? undefined,
    cwd: r.cwd ?? undefined,
    model: r.model ?? undefined,
    reasoningEffort: (r.reasoning_effort as AiSession["reasoningEffort"]) ?? undefined,
    channels: r.channels_json
      ? (JSON.parse(r.channels_json) as SessionChannelBindings)
      : undefined,
    watch: r.watch == null ? undefined : Boolean(r.watch),
    watchStartedAt: r.watch_started_at ?? undefined,
    resume: r.resume == null ? undefined : Boolean(r.resume),
    resumeStartedAt: r.resume_started_at ?? undefined,
    resumeUntil: r.resume_until ?? undefined,
    resumePendingTasks: r.resume_pending_tasks_json
      ? (JSON.parse(r.resume_pending_tasks_json) as ResumeBgTask[])
      : undefined,
    lastBotMessageAt: r.last_bot_message_at ?? undefined,
    lastBotMessagePreview: r.last_bot_message_preview ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRow(s: AiSession): Row {
  return {
    id: s.id,
    name: s.name,
    provider: s.provider,
    session_id: s.sessionId ?? null,
    cwd: s.cwd ?? null,
    model: s.model ?? null,
    reasoning_effort: s.reasoningEffort ?? null,
    channels_json: s.channels ? JSON.stringify(s.channels) : null,
    watch: s.watch == null ? null : s.watch ? 1 : 0,
    watch_started_at: s.watchStartedAt ?? null,
    resume: s.resume == null ? null : s.resume ? 1 : 0,
    resume_started_at: s.resumeStartedAt ?? null,
    resume_until: s.resumeUntil ?? null,
    resume_pending_tasks_json: s.resumePendingTasks
      ? JSON.stringify(s.resumePendingTasks)
      : null,
    last_bot_message_at: s.lastBotMessageAt ?? null,
    last_bot_message_preview: s.lastBotMessagePreview ?? null,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

const COLUMNS = Object.keys(toRow({ id: "", name: null, provider: "", createdAt: "", updatedAt: "" } as AiSession));
const PLACEHOLDERS = COLUMNS.map((c) => `@${c}`).join(", ");
const ASSIGNMENTS = COLUMNS.filter((c) => c !== "id").map((c) => `${c} = @${c}`).join(", ");

export function read(id: string): AiSession | null {
  importLegacyJsonsOnce();
  const row = db().prepare(`SELECT * FROM ai_sessions WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function write(s: AiSession): AiSession {
  importLegacyJsonsOnce();
  s.updatedAt = new Date().toISOString();
  const row = toRow(s);
  db().prepare(
    `INSERT INTO ai_sessions (${COLUMNS.join(", ")})
     VALUES (${PLACEHOLDERS})
     ON CONFLICT(id) DO UPDATE SET ${ASSIGNMENTS}`,
  ).run(row);
  return s;
}

export function remove(id: string): boolean {
  importLegacyJsonsOnce();
  const info = db().prepare(`DELETE FROM ai_sessions WHERE id = ?`).run(id);
  return info.changes > 0;
}

export function list(): AiSession[] {
  importLegacyJsonsOnce();
  const rows = db()
    .prepare(`SELECT * FROM ai_sessions ORDER BY updated_at DESC`)
    .all() as Row[];
  return rows.map(fromRow);
}

export function findByProviderSession(
  provider: string,
  providerSessionId: string,
): AiSession | null {
  importLegacyJsonsOnce();
  const row = db()
    .prepare(
      `SELECT * FROM ai_sessions WHERE provider = ? AND session_id = ? LIMIT 1`,
    )
    .get(provider, providerSessionId) as Row | undefined;
  return row ? fromRow(row) : null;
}

// findByTelegramChat scans the channels_json blob since we don't index into
// JSON. This runs on every Telegram message dispatch — at low session counts
// (dozens) the table scan is fine; revisit with a trigger-maintained index if
// the table grows past hundreds.
export function findByTelegramChat(chatId: number): AiSession | null {
  importLegacyJsonsOnce();
  for (const ai of list()) {
    if (ai.channels?.telegram?.chatId === chatId) return ai;
  }
  return null;
}

export function create(args: {
  provider: string;
  sessionId?: string;
  name?: string | null;
  model?: string;
  cwd?: string;
}): AiSession {
  const now = new Date().toISOString();
  const ai: AiSession = {
    id: newAiSessionId(),
    name: args.name ?? null,
    provider: args.provider,
    sessionId: args.sessionId,
    cwd: args.cwd,
    model: args.model,
    createdAt: now,
    updatedAt: now,
  };
  return write(ai);
}

// One-shot import of any pre-SQLite flat JSONs under <dataDir>/sessions/. Runs
// at most once per process: after the first call, the legacy directory is
// renamed to sessions.imported.<timestamp> so it can't be re-imported but is
// kept as a backup for one rollback. No-op when the directory doesn't exist.
let imported = false;
function importLegacyJsonsOnce(): void {
  if (imported) return;
  imported = true;
  const legacy = join(dataDir(), "sessions");
  if (!existsSync(legacy)) return;
  ensureDir(legacy);
  const files = readdirSync(legacy).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return;
  let count = 0;
  const insert = db().prepare(
    `INSERT OR IGNORE INTO ai_sessions (${COLUMNS.join(", ")}) VALUES (${PLACEHOLDERS})`,
  );
  const tx = db().transaction((rows: Row[]) => {
    for (const r of rows) insert.run(r);
  });
  const rows: Row[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(legacy, f), "utf8"));
      const ai = legacyMigrate(raw);
      if (ai) {
        rows.push(toRow(ai));
        count++;
      }
    } catch {
      /* skip — corrupt file, leave on disk for inspection */
    }
  }
  tx(rows);
  const backup = `${legacy}.imported.${Date.now()}`;
  try {
    renameSync(legacy, backup);
    console.error(`[db] imported ${count} ai-sessions from ${legacy}; backed up to ${backup}`);
  } catch (e: any) {
    console.error(`[db] imported ${count} ai-sessions but couldn't rename backup: ${e?.message ?? e}`);
  }
}

// Salvage the old multi-provider shape (pre-SQLite JSONs) by picking the
// most recently-used binding. Returns null if the entry can't be salvaged.
function legacyMigrate(raw: any): AiSession | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.provider === "string" && typeof raw.id === "string") {
    return raw as AiSession;
  }
  if (raw.providers && typeof raw.providers === "object") {
    const entries = Object.entries(raw.providers as Record<string, any>);
    if (!entries.length) return null;
    entries.sort((a, b) =>
      String(b[1]?.lastUsedAt ?? "").localeCompare(String(a[1]?.lastUsedAt ?? "")),
    );
    const [provider, link] = entries[0];
    if (!link?.sessionId) return null;
    return {
      id: raw.id,
      name: raw.name ?? null,
      provider,
      sessionId: link.sessionId,
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
    };
  }
  return null;
}
