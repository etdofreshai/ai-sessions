import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal .env parser: KEY=value per line, # comments, optional quotes.
// Doesn't handle multiline values or shell-style escapes.
export function loadDotenv(dir: string | undefined): Record<string, string> {
  if (!dir) return {};
  const path = join(dir, ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Allow optional `export ` prefix.
    const stripped = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
