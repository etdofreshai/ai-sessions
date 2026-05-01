export type JobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// Per-kind payload shapes. Add new variants here when a new kind lands.
export type JobPayload =
  | {
      kind: "bash";
      cmd: string;
      cwd?: string;
      // Hard cap so a runaway script can't hold a job slot forever. Optional;
      // omitted means "no timeout, run as long as it takes." Useful for
      // long-running deploys / soaks.
      timeoutMs?: number;
    };

export interface JobResultBash {
  kind: "bash";
  exitCode: number | null;
  signal?: string;
  // Tail of combined stdout+stderr (we cap to keep prompt costs bounded).
  outputTail: string;
  totalBytes: number;
}

export type JobResult = JobResultBash;

export interface Job {
  id: string;
  kind: JobPayload["kind"];
  payload: JobPayload;
  status: JobStatus;
  // Human-friendly summary for status displays / system-prompt outstanding
  // jobs section. The agent supplies this when starting the job.
  label?: string;
  // Where the worker should inject the result when the job finishes. If
  // unset, the worker just records the result and stops — useful for
  // fire-and-forget jobs the agent doesn't want to be re-engaged about.
  aiSessionId?: string;
  // Direct-channel destination — currently only Telegram chat ids. When
  // set, the worker also posts a brief "job X finished" line to the chat
  // before re-entering the session. Falls back to the AiSession's bound
  // channel.
  chatId?: number;
  // Live PID while running — null otherwise. We persist it so a CLI tool
  // (or admin) can SIGTERM a job the worker is hosting in this process.
  pid?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: JobResult;
  error?: string;
}
