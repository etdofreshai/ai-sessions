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
  internal?: boolean;
}): {
  preResolvedAiSessionId?: string;
  // Provider sessionId to actually use for this run (auto-resolved from --as
  // when the caller didn't supply --session). Caller should pass this to the
  // provider SDK as the resume id.
  effectiveProviderSessionId?: string;
  attachToMeta: (meta: RunMetadata) => Promise<void>;
} {
  if (args.internal) {
    // Internal runs are never auto-mapped to AiSessions.
    return {
      effectiveProviderSessionId: args.sessionId,
      attachToMeta: async () => {},
    };
  }

  const pre = preResolve({
    provider: args.provider,
    asId: args.asId,
    providerSessionId: args.sessionId,
  });

  // If --as resolved an AiSession that already has a mapping for this
  // provider, resume that provider session unless caller explicitly passed
  // --session (which takes priority).
  const effectiveProviderSessionId =
    args.sessionId ?? pre.preexisting?.providers[args.provider]?.sessionId;

  // Brand-new AiSession path: kick off naming in parallel.
  let pendingName: Promise<string> | undefined;
  if (!pre.preexisting) {
    pendingName = generateName(args.prompt);
  }

  const preResolvedAiSessionId = pre.preexisting?.id;

  const attachToMeta = async (meta: RunMetadata): Promise<void> => {
    if (meta.status !== "completed") return; // only attach successful runs
    if (!meta.sessionId) return; // can't map without a provider sessionId
    if (pre.preexisting) {
      const ai = finalizeStore({
        preexisting: pre.preexisting,
        provider: args.provider,
        providerSessionId: meta.sessionId,
        name: null,
      });
      meta.aiSessionId = ai.id;
      return;
    }
    // Re-check by providerSessionId in case the run actually returned a known
    // session id (rare, but covers race conditions).
    const found = store.findByProviderSession(args.provider, meta.sessionId);
    if (found) {
      const ai = finalizeStore({
        preexisting: found,
        provider: args.provider,
        providerSessionId: meta.sessionId,
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
      name,
    });
    meta.aiSessionId = ai.id;
  };

  return { preResolvedAiSessionId, effectiveProviderSessionId, attachToMeta };
}
