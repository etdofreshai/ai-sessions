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

export interface RunOptions {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  yolo?: boolean;
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
