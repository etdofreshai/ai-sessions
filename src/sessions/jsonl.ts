import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  const out: T[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export function fileTimes(path: string): { createdAt: string; updatedAt: string } {
  const s = statSync(path);
  return {
    createdAt: (s.birthtime ?? s.ctime).toISOString(),
    updatedAt: s.mtime.toISOString(),
  };
}
