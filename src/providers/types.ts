import type { RunHandle } from "../runs/types.js";

export interface SessionSummary {
  id: string;
  provider: string;
  path: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  raw?: unknown;
}

export interface SessionDetail extends SessionSummary {
  messages: SessionMessage[];
}

export interface Attachment {
  // "image" → passed natively when supported (claude base64 block,
  // codex local_image item); falls back to path reference otherwise.
  // "document" → always passed as path reference in the prompt text.
  kind: "image" | "document";
  path: string; // absolute path on disk
  filename?: string;
  mimeType?: string;
}

export interface RunOptions {
  prompt: string;
  attachments?: Attachment[];
  sessionId?: string;
  cwd?: string;
  yolo?: boolean;
  internal?: boolean;
  aiSessionId?: string;
  // Reasoning effort hint. Honored by providers that support it (claude).
  effort?: "low" | "medium" | "high" | "xhigh";
}

export function defaultYolo(): boolean {
  const v = process.env.AI_SESSIONS_YOLO;
  if (v == null) return true;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

export interface Provider {
  name: string;
  isAvailable(): Promise<boolean>;
  listSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail>;
  // Returns immediately with a RunHandle; events stream via handle.events,
  // final state via handle.done.
  run(opts: RunOptions): RunHandle;
}
