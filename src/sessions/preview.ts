import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Read up to MAX_SCAN lines from a JSONL session file and return the first
// "real" user message text suitable for use as a label preview. Skips system
// noise (queue ops, environment_context blocks, system reminders, slash
// commands).
const MAX_SCAN = 30;

function looksLikeNoise(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  // System-injected wrappers we don't want as titles.
  if (t.startsWith("<")) return true;          // <environment_context>, <system-reminder>, <command-name>
  if (t.startsWith("[Image")) return true;     // attached image stub
  if (t.startsWith("Caveat:")) return true;
  return false;
}

function extractText(entry: any): { text: string; role?: string } | null {
  // Claude shape: { type:'user', message:{ role, content } }
  // Codex shape: { type:'response_item', payload:{ type:'message', role, content } }
  // Generic:     { role, content } or { payload:{ role, content } }
  const msg = entry?.message ?? entry?.payload ?? entry;
  const role = msg?.role ?? entry?.role;
  const content = msg?.content;

  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c?.text) return c.text;
        if (c?.type === "input_text" && c.text) return c.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  if (!text) return null;
  return { text, role };
}

export async function previewFromJsonl(path: string): Promise<string> {
  let scanned = 0;
  try {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      scanned++;
      if (scanned > MAX_SCAN) break;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const got = extractText(entry);
      if (!got) continue;
      // Only user messages make good titles.
      if (got.role && got.role !== "user") continue;
      if (looksLikeNoise(got.text)) continue;
      rl.close();
      return got.text.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  } catch {
    /* ignore */
  }
  return "";
}
