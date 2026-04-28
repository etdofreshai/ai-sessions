import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const MAX_SCAN = 30;

export interface SessionPreview {
  text: string; // first user message (or empty)
  cwd: string; // working directory the session was created in (or empty)
}

function looksLikeNoise(text: string): boolean {
  const t = text.trimStart();
  if (!t) return true;
  if (t.startsWith("<")) return true;
  if (t.startsWith("[Image")) return true;
  if (t.startsWith("Caveat:")) return true;
  return false;
}

function extractText(entry: any): { text: string; role?: string } | null {
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

function extractCwd(entry: any): string {
  return (
    entry?.cwd ??
    entry?.payload?.cwd ??
    entry?.message?.cwd ??
    ""
  );
}

// Returns text + cwd. Both fall back to "" when unavailable.
export async function previewFromJsonl(path: string): Promise<SessionPreview> {
  let scanned = 0;
  let foundText = "";
  let foundCwd = "";
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
      if (!foundCwd) {
        const c = extractCwd(entry);
        if (c) foundCwd = c;
      }
      if (!foundText) {
        const got = extractText(entry);
        if (got && (!got.role || got.role === "user") && !looksLikeNoise(got.text)) {
          foundText = got.text.replace(/\s+/g, " ").trim().slice(0, 60);
        }
      }
      if (foundText && foundCwd) {
        rl.close();
        break;
      }
    }
  } catch {
    /* ignore */
  }
  return { text: foundText, cwd: foundCwd };
}

// Shortens a path to: first 4 chars + "…/" + basename.
// Returns the input as-is if it's already short enough.
export function shortenPath(p: string): string {
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const last = norm.split("/").filter(Boolean).pop() ?? "";
  if (norm.length <= 4 + 2 + last.length) return norm;
  return `${norm.slice(0, 4)}…/${last}`;
}
