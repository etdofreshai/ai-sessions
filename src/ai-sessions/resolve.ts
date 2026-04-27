import * as store from "./store.js";
import type { AiSession } from "./types.js";

export interface ResolveArgs {
  provider: string;
  asId?: string; // explicit AiSession id from --as
  providerSessionId?: string; // raw --session
}

export interface PreResolveResult {
  // The AiSession object known up-front (if --as resolved an existing one).
  preexisting: AiSession | null;
  // Whether to look up after the run by providerSessionId returned from the run.
  // When true, the post-run finalize step will create or attach as needed.
  needsPostResolve: boolean;
}

// Pre-run resolution: handles `--as <id>` and known `--session <id>` mappings.
// Returns the AiSession to attribute the run to, if known. If null, the
// finalize step (post-run) decides based on the provider session id returned.
export function preResolve(args: ResolveArgs): PreResolveResult {
  if (args.asId) {
    const existing = store.read(args.asId);
    if (!existing) {
      throw new Error(`ai-session not found: ${args.asId}`);
    }
    return { preexisting: existing, needsPostResolve: false };
  }
  if (args.providerSessionId) {
    const found = store.findByProviderSession(args.provider, args.providerSessionId);
    if (found) return { preexisting: found, needsPostResolve: false };
  }
  // Need post-run resolution.
  return { preexisting: null, needsPostResolve: true };
}

// Post-run finalization: given a successful run's providerSessionId, ensure
// the run is attached to an AiSession. If preexisting is provided, attach the
// provider session to it (no naming). Otherwise create a fresh AiSession with
// the supplied (already-generated) name.
export function finalize(args: {
  preexisting: AiSession | null;
  provider: string;
  providerSessionId: string;
  name: string | null;
}): AiSession {
  if (args.preexisting) {
    return store.attach(args.preexisting, args.provider, args.providerSessionId);
  }
  // Fresh AiSession.
  const now = new Date().toISOString();
  const ai: AiSession = {
    id: store.newAiSessionId(),
    name: args.name,
    createdAt: now,
    updatedAt: now,
    providers: {
      [args.provider]: {
        sessionId: args.providerSessionId,
        lastUsedAt: now,
      },
    },
  };
  return store.write(ai);
}
