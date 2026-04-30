import { defaultAgent } from "../config.js";
import { getProvider } from "../providers/index.js";
import { runToCompletion } from "../runs/drain.js";

const SUMMARY_PROMPT = `Summarize the following conversation transcript in roughly 200-300 tokens. Preserve facts established, decisions made, code or commands referenced, and any open questions. Do not editorialize. Reply with ONLY the summary, no preamble.

Transcript:
`;

// Returns a compact summary suitable for seeding a new session on a different
// provider. Uses the default AI agent. Best-effort; throws on unrecoverable
// failure since fork callers want to know.
export async function summarizeTranscript(transcript: string): Promise<string> {
  const provider = getProvider(defaultAgent());
  const meta = await runToCompletion(
    provider.run({
      prompt: SUMMARY_PROMPT + transcript,
      yolo: true,
      internal: true,
    }),
  );
  if (meta.status !== "completed" || !meta.output) {
    throw new Error(`summary run did not produce output (status=${meta.status})`);
  }
  return meta.output.trim();
}
