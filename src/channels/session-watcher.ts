import {
  watch as fsWatch,
  statSync,
  openSync,
  readSync,
  closeSync,
  type FSWatcher,
} from "node:fs";
import { getProvider } from "../providers/index.js";
import type { AiSession } from "../ai-sessions/types.js";

export type ForwardFn = (role: "user" | "assistant", text: string) => void;

interface Entry {
  watcher: FSWatcher;
  path: string;
  offset: number;
  muted: boolean;
  reading: boolean;
  pending: NodeJS.Timeout | null;
  forward: ForwardFn;
  partial: string;
}

const entries = new Map<string, Entry>();
// Wait for the file to go quiet before reading; claude writes streaming
// chunks rapidly, so a small debounce avoids forwarding partial deltas.
const FLUSH_DELAY_MS = 800;

export async function start(
  ai: AiSession,
  forward: ForwardFn
): Promise<{ ok: boolean; error?: string }> {
  if (ai.provider !== "claude") {
    return { ok: false, error: "watch only supports claude sessions" };
  }
  if (!ai.sessionId) {
    return { ok: false, error: "session has no claude session id yet" };
  }
  if (entries.has(ai.id)) return { ok: true };

  let path: string;
  try {
    const list = await getProvider("claude").listSessions();
    const m = list.find((s) => s.id === ai.sessionId);
    if (!m) return { ok: false, error: "session jsonl not found on disk" };
    path = m.path;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  let offset = 0;
  try {
    offset = statSync(path).size;
  } catch {
    /* ignore */
  }

  const entry: Entry = {
    watcher: null as any,
    path,
    offset,
    muted: false,
    reading: false,
    pending: null,
    forward,
    partial: "",
  };

  const onChange = () => {
    if (entry.pending) clearTimeout(entry.pending);
    entry.pending = setTimeout(() => {
      entry.pending = null;
      void readNew(entry);
    }, FLUSH_DELAY_MS);
  };

  try {
    entry.watcher = fsWatch(path, { persistent: false }, onChange);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  entries.set(ai.id, entry);
  return { ok: true };
}

async function readNew(e: Entry): Promise<void> {
  if (e.reading || e.muted) return;
  e.reading = true;
  try {
    let size: number;
    try {
      size = statSync(e.path).size;
    } catch {
      return;
    }
    if (size <= e.offset) return;
    const fd = openSync(e.path, "r");
    let chunk: string;
    try {
      const length = size - e.offset;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, e.offset);
      chunk = buf.toString("utf8");
      e.offset = size;
    } finally {
      closeSync(fd);
    }
    const text = e.partial + chunk;
    const lines = text.split(/\r?\n/);
    e.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const role = parsed?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const flat = flattenContent(parsed?.message?.content);
      if (!flat) continue;
      e.forward(role, flat);
    }
  } finally {
    e.reading = false;
  }
}

// Pulls plain user-visible text out of a claude message body. Skips tool_use
// and tool_result blocks so the channel doesn't get spammed with internals.
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content as any[]) {
      if (typeof c === "string") parts.push(c);
      else if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
    return parts.join("\n").trim();
  }
  return "";
}

export function stop(aiId: string): boolean {
  const e = entries.get(aiId);
  if (!e) return false;
  try {
    e.watcher.close();
  } catch {
    /* ignore */
  }
  if (e.pending) clearTimeout(e.pending);
  entries.delete(aiId);
  return true;
}

export function isWatching(aiId: string): boolean {
  return entries.has(aiId);
}

// Suppress forwarding for the duration of an in-app run on this session.
// Returns an unmute function — when called, the file's current EOF is
// snapshotted as the new offset, so anything our run wrote is skipped.
export function mute(aiId: string): () => void {
  const e = entries.get(aiId);
  if (!e) return () => {};
  e.muted = true;
  return () => {
    e.muted = false;
    try {
      e.offset = statSync(e.path).size;
    } catch {
      /* ignore */
    }
    e.partial = "";
  };
}

export function stopAll(): void {
  for (const e of entries.values()) {
    try {
      e.watcher.close();
    } catch {
      /* ignore */
    }
    if (e.pending) clearTimeout(e.pending);
  }
  entries.clear();
}
