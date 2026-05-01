import * as store from "./store.js";
import type { AiSession } from "./types.js";

export interface ResolveArgs {
  provider: string;
  asId?: string;
  providerSessionId?: string;
}

export interface PreResolveResult {
  preexisting: AiSession | null;
  needsPostResolve: boolean;
}

// AiSessions are now single-provider. `--as` requires the AiSession to be
// bound to the same provider as the current run; otherwise the caller must
// fork instead.
export function preResolve(args: ResolveArgs): PreResolveResult {
  if (args.asId) {
    const existing = store.read(args.asId);
    if (!existing) {
      throw new Error(`ai-session not found: ${args.asId}`);
    }
    if (existing.provider !== args.provider) {
      throw new Error(
        `ai-session ${args.asId} is bound to provider "${existing.provider}", ` +
          `cannot use with provider "${args.provider}". ` +
          `Use \`ais sessions fork ${args.asId} ${args.provider}\` to create a new AiSession on the target provider.`
      );
    }
    return { preexisting: existing, needsPostResolve: false };
  }
  if (args.providerSessionId) {
    const found = store.findByProviderSession(args.provider, args.providerSessionId);
    if (found) return { preexisting: found, needsPostResolve: false };
  }
  return { preexisting: null, needsPostResolve: true };
}

// Post-run finalization: ensure the run is attached to an AiSession.
export function finalize(args: {
  preexisting: AiSession | null;
  provider: string;
  providerSessionId: string;
  cwd?: string;
  name: string | null;
}): AiSession {
  if (args.preexisting) {
    args.preexisting.sessionId = args.providerSessionId;
    if (args.cwd && !args.preexisting.cwd) args.preexisting.cwd = args.cwd;
    if (!args.preexisting.name && args.name) args.preexisting.name = args.name;
    return store.write(args.preexisting);
  }
  return store.create({
    provider: args.provider,
    sessionId: args.providerSessionId,
    cwd: args.cwd,
    name: args.name,
  });
}
