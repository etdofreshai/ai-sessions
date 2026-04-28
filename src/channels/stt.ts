import { readFileSync } from "node:fs";
import { basename } from "node:path";

// POST a local audio file to a Whisper-compatible /v1/audio/transcriptions
// endpoint and return the transcribed text.
export async function transcribe(
  filePath: string,
  opts: { mimeType?: string } = {}
): Promise<string> {
  const baseUrl = (process.env.STT_URL || "https://stt.etdofresh.com").replace(/\/+$/, "");
  const apiKey = process.env.STT_API_KEY;
  const model = process.env.STT_MODEL || "whisper-1";

  const fileBuf = readFileSync(filePath);
  const blob = new Blob([fileBuf], {
    type: opts.mimeType || "application/octet-stream",
  });
  const form = new FormData();
  form.append("file", blob, basename(filePath));
  form.append("model", model);

  const res = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`STT request failed: ${res.status} ${res.statusText} ${detail}`);
  }
  const json: any = await res.json();
  return String(json.text ?? "").trim();
}
