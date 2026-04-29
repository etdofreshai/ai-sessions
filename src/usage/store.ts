import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import type { UsageSnapshot } from "./types.js";

function dir(): string {
  const d = join(dataDir(), "usage");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function read(provider: string): UsageSnapshot | null {
  const p = join(dir(), `${provider}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function write(snap: UsageSnapshot): void {
  const p = join(dir(), `${snap.provider}.json`);
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  renameSync(tmp, p);
}
