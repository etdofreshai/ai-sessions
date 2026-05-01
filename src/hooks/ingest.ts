import * as hookStore from "./store.js";
import { dispatchHook } from "./dispatch.js";

export function ingestHook(args: {
  harness: "claude" | "codex";
  payload: Record<string, unknown>;
}): hookStore.HookEventRecord {
  const ev = hookStore.record(args);
  try {
    dispatchHook(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[hooks/${args.harness}] dispatch failed:`, message);
  }
  return ev;
}
