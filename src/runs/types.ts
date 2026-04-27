export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "interrupted"
  | "failed";

export type RunEvent =
  | { type: "session_id"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input?: unknown }
  | { type: "tool_result"; name?: string; output?: unknown }
  | { type: "error"; message: string }
  | { type: "end"; sessionId?: string; output: string };

export interface RunMetadata {
  runId: string;
  provider: string;
  sessionId?: string;
  aiSessionId?: string;
  status: RunStatus;
  prompt: string;
  cwd?: string;
  yolo: boolean;
  internal?: boolean;
  createdAt: string;
  endedAt?: string;
  output?: string;
  error?: string;
}

export interface RunHandle {
  meta: RunMetadata;
  events: AsyncIterable<RunEvent>;
  done: Promise<RunMetadata>;
  interrupt(): Promise<void>;
  steer?(input: string): Promise<void>;
}
