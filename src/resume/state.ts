import * as aiStore from "../ai-sessions/store.js";
import type { AiSession, ResumeBgTask } from "../ai-sessions/types.js";

export const DEFAULT_RESUME_TTL_MS = 60 * 60 * 1000;

// Slide the resume deadline forward by the default TTL whenever activity is
// observed (route turn, watcher forward, bg-task fire). No-op when resume is
// disabled.
export function slideResume(ai: AiSession): void {
  if (ai.resume !== true) return;
  ai.resumeUntil = new Date(Date.now() + DEFAULT_RESUME_TTL_MS).toISOString();
  aiStore.write(ai);
}

export function isResumeExpired(ai: AiSession, now = Date.now()): boolean {
  if (ai.resume !== true) return false;
  if (!ai.resumeUntil) return false;
  return new Date(ai.resumeUntil).getTime() <= now;
}

// Enable resume — sets resume=true, stamps resumeStartedAt if not already
// running, and slides the deadline. Idempotent.
export function enableResume(ai: AiSession): void {
  const wasOff = ai.resume !== true;
  ai.resume = true;
  if (wasOff || !ai.resumeStartedAt) {
    ai.resumeStartedAt = new Date().toISOString();
  }
  ai.resumeUntil = new Date(Date.now() + DEFAULT_RESUME_TTL_MS).toISOString();
  aiStore.write(ai);
}

export function disableResume(ai: AiSession): void {
  ai.resume = false;
  ai.resumeStartedAt = undefined;
  ai.resumeUntil = undefined;
  ai.resumePendingTasks = undefined;
  aiStore.write(ai);
}

// Append a captured bg task to the AiSession's pending list (deduped by id).
export function recordPendingTask(aiId: string, task: ResumeBgTask): void {
  const ai = aiStore.read(aiId);
  if (!ai) return;
  if (ai.resume !== true) return;
  const existing = ai.resumePendingTasks ?? [];
  if (existing.some((t) => t.id === task.id)) return;
  existing.push(task);
  ai.resumePendingTasks = existing;
  aiStore.write(ai);
}

// Mark a task as "fired" (re-entry turn dispatched) and drop it from the
// pending list on the next persist.
export function dropPendingTask(aiId: string, taskId: string): void {
  const ai = aiStore.read(aiId);
  if (!ai) return;
  ai.resumePendingTasks = (ai.resumePendingTasks ?? []).filter((t) => t.id !== taskId);
  aiStore.write(ai);
}
