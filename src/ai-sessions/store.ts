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

export function read(id: string): AiSession | null {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AiSession;
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
      out.push(JSON.parse(readFileSync(join(sessionsDir(), f), "utf8")));
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function findByProviderSession(
  provider: string,
  providerSessionId: string,
): AiSession | null {
  for (const s of list()) {
    if (s.providers[provider]?.sessionId === providerSessionId) return s;
  }
  return null;
}

export function attach(
  ai: AiSession,
  provider: string,
  providerSessionId: string,
): AiSession {
  ai.providers[provider] = {
    sessionId: providerSessionId,
    lastUsedAt: new Date().toISOString(),
  };
  return write(ai);
}
