// Supervisor-driven task queue for long-horizon multi-agent plans.
// A task belongs to one supervisor AiSession, optionally depends on other
// tasks, and (when launched) is linked to a sub_agents row that handles
// the actual provider session.

export type TaskStatus =
  | "created"
  | "running"
  | "merge_failed"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskMergeStrategy = "auto" | "manual";

export type TaskEventType =
  | "created"
  | "dependency_added"
  | "dependency_removed"
  | "started"
  | "activity"
  | "completed"
  | "failed"
  | "merge_failed"
  | "cancelled"
  | "retry";

export interface SubAgentTask {
  id: string;
  aiSessionId: string;
  title: string;
  prompt: string;
  response?: string;
  status: TaskStatus;
  provider?: string;
  providerSessionId?: string;
  subAgentId?: string;
  effort?: string;
  cwd?: string;
  baseRef?: string;
  branchName?: string;
  worktreePath?: string;
  mergeStrategy: TaskMergeStrategy;
  attemptCount: number;
  maxAttempts: number;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deletedAt?: string;
}

export interface SubAgentTaskDependency {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
}

export interface SubAgentTaskEvent {
  id: string;
  taskId: string;
  eventType: TaskEventType;
  message?: string;
  createdAt: string;
}
