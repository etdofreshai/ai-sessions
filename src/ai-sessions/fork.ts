import { getProvider } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";
import * as store from "./store.js";
import { summarizeTranscript } from "./summarize.js";
import type { AiSession } from "./types.js";

// Approximate token budgets per provider. Override via env vars.
function tokenBudget(provider: string): number {
  const env = process.env[`AI_SESSIONS_TOKEN_BUDGET_${provider.toUpperCase()}`];
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  switch (provider) {
    case "claude":
      return 1_000_000;
    case "codex":
      return 400_000;
    case "opencode":
      return 200_000;
    default:
      return 100_000;
  }
}

// Cheap heuristic: ~3.5 chars per token for English-ish text.
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

function renderTranscript(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

export interface ForkResult {
  id: string;
  name: string | null;
  provider: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  seedMode: "replay" | "summary";
  estimatedTokens: number;
}

export async function forkAiSession(args: {
  sourceId: string;
  targetProvider: string;
  destructive?: boolean;
  cwd?: string;
}): Promise<ForkResult> {
  const source = store.read(args.sourceId);
  if (!source) throw new Error(`ai-session not found: ${args.sourceId}`);
  if (source.provider === args.targetProvider) {
    throw new Error(
      `cannot fork into the same provider (${args.targetProvider}); use --as for resume`
    );
  }

  if (!source.sessionId) {
    throw new Error(
      `source AiSession ${source.id} has no provider sessionId yet (no runs have completed); nothing to fork`
    );
  }
  const sourceProvider = getProvider(source.provider);
  const detail = await sourceProvider.getSession(source.sessionId);
  const transcript = renderTranscript(detail.messages);
  const transcriptTokens = estimateTokens(transcript);
  const budget = tokenBudget(args.targetProvider);

  let seed: string;
  let seedMode: "replay" | "summary";
  if (args.destructive || transcriptTokens > budget * 0.8) {
    const summary = await summarizeTranscript(transcript);
    seed = `Continuing a conversation from another agent. Here is a summary of what's been discussed:\n\n${summary}\n\nContinue from this point.`;
    seedMode = "summary";
  } else {
    seed = `Continuing a conversation from another agent. Here is the full transcript:\n\n${transcript}\n\nContinue from this point.`;
    seedMode = "replay";
  }

  // Run the seed on the target provider as an internal run (so it doesn't
  // auto-create yet another AiSession). We attach explicitly below.
  const targetProvider = getProvider(args.targetProvider);
  const meta = await runToCompletion(
    targetProvider.run({
      prompt: seed,
      cwd: args.cwd,
      yolo: true,
      internal: true,
    }),
  );
  if (meta.status !== "completed" || !meta.sessionId) {
    throw new Error(
      `seed run on ${args.targetProvider} did not complete (status=${meta.status}${
        meta.error ? `: ${meta.error}` : ""
      })`
    );
  }

  const ai: AiSession = store.create({
    provider: args.targetProvider,
    sessionId: meta.sessionId,
    name: source.name,
  });

  return {
    id: ai.id,
    name: ai.name,
    provider: ai.provider,
    sessionId: ai.sessionId,
    createdAt: ai.createdAt,
    updatedAt: ai.updatedAt,
    seedMode,
    estimatedTokens: transcriptTokens,
  };
}
