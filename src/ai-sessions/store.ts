import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir } from "../config.js";
import type { AiSession } from "./types.js";

function sessionsDir(): string {
  const dir = join(dataDir(), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export function newAiSessionId(): string {
  return randomUUID();
}

// Best-effort migration from the old multi-provider shape: pick the most
// recently-used binding. Returns null if the entry can't be salvaged.
function migrate(raw: any): AiSession | null {
  if (!raw || typeof raw !== "object") return null;
  // New shape: provider is required, sessionId is optional (empty until first
  // run completes for sessions created via the Telegram "+ new" flow).
  if (typeof raw.provider === "string" && typeof raw.id === "string") {
    return raw as AiSession;
  }
  if (raw.providers && typeof raw.providers === "object") {
    const entries = Object.entries(raw.providers as Record<string, any>);
    if (!entries.length) return null;
    entries.sort((a, b) =>
      String(b[1]?.lastUsedAt ?? "").localeCompare(String(a[1]?.lastUsedAt ?? ""))
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

export function read(id: string): AiSession | null {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return migrate(raw);
  } catch {
    return null;
  }
}

export function write(s: AiSession): AiSession {
  s.updatedAt = new Date().toISOString();
  writeFileSync(sessionPath(s.id), JSON.stringify(s, null, 2));
  return s;
}

export function remove(id: string): boolean {
  const p = sessionPath(id);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function list(): AiSession[] {
  if (!existsSync(sessionsDir())) return [];
  const files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  const out: AiSession[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(sessionsDir(), f), "utf8"));
      const s = migrate(raw);
      if (s) out.push(s);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// Find the AiSession that owns this (provider, providerSessionId) pair.
export function findByProviderSession(
  provider: string,
  providerSessionId: string,
): AiSession | null {
  for (const s of list()) {
    if (s.provider === provider && s.sessionId === providerSessionId) return s;
  }
  return null;
}

// Find the AiSession bound to a given Telegram chat id.
export function findByTelegramChat(chatId: number): AiSession | null {
  for (const s of list()) {
    if (s.channels?.telegram?.chatId === chatId) return s;
  }
  return null;
}

export function create(args: {
  provider: string;
  sessionId?: string;
  name?: string | null;
  model?: string;
}): AiSession {
  const now = new Date().toISOString();
  const ai: AiSession = {
    id: newAiSessionId(),
    name: args.name ?? null,
    provider: args.provider,
    sessionId: args.sessionId,
    model: args.model,
    createdAt: now,
    updatedAt: now,
  };
  return write(ai);
}
