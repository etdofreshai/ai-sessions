import type { RunMetadata } from "../runs/types.js";
import { generateName } from "./naming.js";
import { finalize as finalizeStore, preResolve } from "./resolve.js";
import * as store from "./store.js";

export interface AiSessionFinalizeContext {
  internal: boolean;
  asId?: string;
  // Promise that resolves to a generated name when none was preassigned.
  // We start it in parallel with the main run when the AiSession is brand-new.
  pendingName?: Promise<string>;
}

// Build the run-finalization plan up-front. The returned `attachToMeta` should
// be passed to startRun({ onFinalize }) so it runs after the main body resolves.
export function planAiSessionResolution(args: {
  provider: string;
  prompt: string;
  sessionId?: string;
  asId?: string;
  cwd?: string;
  internal?: boolean;
}): {
  preResolvedAiSessionId?: string;
  effectiveProviderSessionId?: string;
  // Caller should use this cwd for the run. When resuming an existing
  // AiSession, the stored cwd is sticky (claude scopes session storage by
  // directory; resuming under a different cwd fails with "no conversation
  // found").
  effectiveCwd?: string;
  attachToMeta: (meta: RunMetadata) => Promise<void>;
} {
  if (args.internal) {
    return {
      effectiveProviderSessionId: args.sessionId,
      effectiveCwd: args.cwd,
      attachToMeta: async () => {},
    };
  }

  const pre = preResolve({
    provider: args.provider,
    asId: args.asId,
    providerSessionId: args.sessionId,
  });

  const effectiveProviderSessionId = args.sessionId ?? pre.preexisting?.sessionId;
  // If we're resuming a known AiSession with a recorded cwd, that wins.
  // Fresh runs use the caller-supplied cwd.
  const effectiveCwd = pre.preexisting?.cwd ?? args.cwd;

  // Brand-new AiSession path: kick off naming in parallel.
  let pendingName: Promise<string> | undefined;
  if (!pre.preexisting) {
    pendingName = generateName(args.prompt);
  }

  const preResolvedAiSessionId = pre.preexisting?.id;

  const attachToMeta = async (meta: RunMetadata): Promise<void> => {
    if (meta.status !== "completed") return;
    if (!meta.sessionId) return;
    if (pre.preexisting) {
      const ai = finalizeStore({
        preexisting: pre.preexisting,
        provider: args.provider,
        providerSessionId: meta.sessionId,
        cwd: meta.cwd ?? pre.preexisting.cwd,
        name: null,
      });
      meta.aiSessionId = ai.id;
      return;
    }
    const found = store.findByProviderSession(args.provider, meta.sessionId);
    if (found) {
      const ai = finalizeStore({
        preexisting: found,
        provider: args.provider,
        providerSessionId: meta.sessionId,
        cwd: meta.cwd ?? found.cwd,
        name: null,
      });
      meta.aiSessionId = ai.id;
      return;
    }
    const name = pendingName ? await pendingName : null;
    const ai = finalizeStore({
      preexisting: null,
      provider: args.provider,
      providerSessionId: meta.sessionId,
      cwd: meta.cwd,
      name,
    });
    meta.aiSessionId = ai.id;
  };

  return {
    preResolvedAiSessionId,
    effectiveProviderSessionId,
    effectiveCwd,
    attachToMeta,
  };
}
