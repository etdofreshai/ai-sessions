import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { ensureDir } from "../fsutil.js";
import { getProvider } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";
import * as store from "./store.js";
import type { AiSession } from "./types.js";

export interface ForkResult {
  id: string;
  name: string | null;
  provider: string;
  sessionId?: string;
  transcriptPath: string;
  messageCount: number;
}

// Fork an AiSession into a new one. The transcript is written to a markdown
// file and passed as a `document` attachment to the seed run, so the new
// agent gets the full conversation history without inflating the prompt
// itself — the model can read the file via Bash whenever it needs context.
//
// Same-provider forks are allowed: the transcript-as-attachment seeding
// works identically regardless of provider, and the seed run produces a
// fresh provider session id so the original isn't disturbed.
export async function forkAiSession(args: {
  sourceId: string;
  // Defaults to the source's provider — i.e. "/fork" with no provider
  // forks within the same provider. Pass a different value to cross over.
  targetProvider?: string;
  cwd?: string;
}): Promise<ForkResult> {
  const source = store.read(args.sourceId);
  if (!source) throw new Error(`ai-session not found: ${args.sourceId}`);
  if (!source.sessionId) {
    throw new Error(
      `source AiSession ${source.id} has no provider sessionId yet (no runs have completed); nothing to fork`,
    );
  }
  const targetProviderName = args.targetProvider ?? source.provider;
  const sourceProvider = getProvider(source.provider);
  const detail = await sourceProvider.getSession(source.sessionId);

  // Write the transcript as a markdown file under the data dir so the seed
  // run can attach it. Path is namespaced by source AiSession id; filename
  // includes a timestamp so successive forks don't overwrite each other.
  const dir = ensureDir(join(dataDir(), "uploads", source.id));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const transcriptPath = join(dir, `transcript-fork-${stamp}.md`);
  writeFileSync(transcriptPath, renderTranscriptMarkdown(source, detail));

  // Seed prompt is intentionally short — the model reads the file when it
  // needs context. Keeps the per-turn token cost predictable regardless
  // of the source conversation's length.
  const seed = [
    `You are continuing a conversation that was forked from another AiSession (${
      args.targetProvider && args.targetProvider !== source.provider
        ? `cross-provider: ${source.provider} → ${targetProviderName}`
        : `same provider: ${source.provider}`
    }).`,
    "",
    `The full transcript is attached as a markdown file. Read it whenever you need context — don't summarize it back to the user unless they ask.`,
    "",
    "Continue from where the conversation left off.",
  ].join("\n");

  const targetProvider = getProvider(targetProviderName);
  const meta = await runToCompletion(
    targetProvider.run({
      prompt: seed,
      attachments: [
        {
          kind: "document",
          path: transcriptPath,
          filename: `fork-${source.id.slice(0, 8)}.md`,
          mimeType: "text/markdown",
        },
      ],
      cwd: args.cwd,
      yolo: true,
      internal: true,
    }),
  );
  if (meta.status !== "completed" || !meta.sessionId) {
    throw new Error(
      `seed run on ${targetProviderName} did not complete (status=${meta.status}${
        meta.error ? `: ${meta.error}` : ""
      })`,
    );
  }

  const ai = store.create({
    provider: targetProviderName,
    sessionId: meta.sessionId,
    name: source.name,
    cwd: args.cwd ?? source.cwd,
  });

  return {
    id: ai.id,
    name: ai.name,
    provider: ai.provider,
    sessionId: ai.sessionId,
    transcriptPath,
    messageCount: detail.messages.length,
  };
}

// Same renderer the /export handler uses — kept local so fork doesn't depend
// on the telegram channel module.
function renderTranscriptMarkdown(
  ai: AiSession,
  detail: { messages: Array<{ role: string; content: string; timestamp?: string }> },
): string {
  const header = [
    `# ${ai.name ?? "(unnamed)"}`,
    "",
    `- Source AiSession: \`${ai.id}\``,
    `- Provider: ${ai.provider}`,
    `- Provider session: \`${ai.sessionId ?? ""}\``,
    `- cwd: ${ai.cwd ?? "(unset)"}`,
    `- Messages: ${detail.messages.length}`,
    `- Forked at: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].join("\n");
  const body = detail.messages
    .map((m) => {
      const ts = m.timestamp ? ` _(${m.timestamp})_` : "";
      return `## ${m.role}${ts}\n\n${m.content}\n`;
    })
    .join("\n");
  return header + body;
}
