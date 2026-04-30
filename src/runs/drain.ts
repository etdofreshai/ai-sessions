import type { RunHandle, RunMetadata } from "./types.js";

// "Fire-and-forget" run helper for callers that don't care about the live
// event stream — they just want the final RunMetadata. Drains events so the
// run actually progresses (the stream is back-pressured) and awaits done.
//
// Use the longhand `for await (const ev of handle.events)` directly when you
// DO need to react to intermediate events (route turns, traces, image-event
// handling, bg-task detection, etc.).
export async function runToCompletion(handle: RunHandle): Promise<RunMetadata> {
  for await (const _ of handle.events) {
    /* drain */
  }
  return handle.done;
}
