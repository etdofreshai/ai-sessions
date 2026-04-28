export type CronTarget =
  | {
      kind: "ai_session";
      aiSessionId: string;
      prompt: string;
      cwd?: string;
    }
  | {
      kind: "provider_session";
      provider: string;
      sessionId?: string;
      prompt: string;
      cwd?: string;
    }
  | {
      kind: "command";
      command: string;
      args?: string[];
      cwd?: string;
    };

export type MissedPolicy = "skip" | "run_once" | "run_all";

export interface CronJob {
  name: string;
  cron: string;
  timezone?: string;
  target: CronTarget;
  enabled: boolean;
  missedPolicy: MissedPolicy;
  nextRunAt: string;
  lastRunAt?: string;
  lastStartedAt?: string;
  lastError?: string;
  createdAt: string;
}
