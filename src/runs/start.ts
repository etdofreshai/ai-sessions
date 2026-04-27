import { EventBus } from "./bus.js";
import { newRunId, persistEvent, persistMeta, register, setStatus } from "./registry.js";
import type { RunEvent, RunHandle, RunMetadata } from "./types.js";

export interface StartRunArgs {
  provider: string;
  prompt: string;
  sessionId?: string;
  cwd?: string;
  yolo: boolean;
  internal?: boolean;
  aiSessionId?: string;
  // Producer body: receives `emit` for events. Should resolve with the final
  // output text. Must call emit({type:"session_id"}) once known. May reject;
  // rejection becomes a "failed" terminal state.
  body: (ctx: {
    runId: string;
    emit: (e: RunEvent) => void;
    onAbort: (cb: () => void) => void;
    onSteer?: (cb: (input: string) => void) => void;
  }) => Promise<{ output: string; sessionId?: string }>;
  // Optional capability hooks.
  steerable?: boolean;
  // Hook called after the run reaches a terminal state. Receives the final
  // metadata; may mutate it (typically to set aiSessionId) and the change
  // will be persisted before the run handle's `done` resolves.
  onFinalize?: (meta: RunMetadata) => Promise<void>;
}

export function startRun(args: StartRunArgs): RunHandle {
  const runId = newRunId();
  const meta: RunMetadata = {
    runId,
    provider: args.provider,
    sessionId: args.sessionId,
    aiSessionId: args.aiSessionId,
    status: "pending",
    prompt: args.prompt,
    cwd: args.cwd,
    yolo: args.yolo,
    internal: args.internal,
    createdAt: new Date().toISOString(),
  };
  persistMeta(meta);

  const bus = new EventBus();
  let abortCb: (() => void) | null = null;
  let steerCb: ((input: string) => void) | null = null;
  let interrupted = false;

  const emit = (e: RunEvent): void => {
    persistEvent(runId, e);
    if (e.type === "session_id" && !meta.sessionId) {
      meta.sessionId = e.sessionId;
      persistMeta(meta);
    }
    bus.push(e);
  };

  setStatus(meta, "running");

  const done = (async (): Promise<RunMetadata> => {
    try {
      const result = await args.body({
        runId,
        emit,
        onAbort: (cb) => {
          abortCb = cb;
        },
        onSteer: args.steerable
          ? (cb) => {
              steerCb = cb;
            }
          : undefined,
      });
      const finalSession = result.sessionId ?? meta.sessionId;
      const endEvent: RunEvent = {
        type: "end",
        sessionId: finalSession,
        output: result.output,
      };
      emit(endEvent);
      setStatus(meta, interrupted ? "interrupted" : "completed", {
        sessionId: finalSession,
        output: result.output,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
      setStatus(meta, "failed", { error: message });
    } finally {
      bus.end();
    }
    if (args.onFinalize) {
      try {
        await args.onFinalize(meta);
        persistMeta(meta);
      } catch (e) {
        // Don't fail the run because of finalize hook errors; surface them as
        // a non-terminal error event would already have been emitted by the
        // hook if it cared.
        const message = e instanceof Error ? e.message : String(e);
        persistEvent(runId, { type: "error", message: `finalize: ${message}` });
      }
    }
    return meta;
  })();

  const handle: RunHandle = {
    meta,
    events: bus,
    done,
    interrupt: async () => {
      interrupted = true;
      if (abortCb) abortCb();
    },
    steer: args.steerable
      ? async (input: string) => {
          if (!steerCb) throw new Error("steer not yet ready for this run");
          steerCb(input);
        }
      : undefined,
  };

  register(handle);
  return handle;
}
