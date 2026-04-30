import { existsSync, mkdirSync } from "node:fs";

// Idempotent mkdir -p. Returns the path so call sites can compose it inline:
//   const dir = ensureDir(join(workspaceDir(), "crons"));
export function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}
