import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Best-effort .env load (Node >=20.6). No-op if no file or older Node.
try {
  // @ts-ignore — loadEnvFile is recent
  if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
    // @ts-ignore
    process.loadEnvFile();
  }
} catch {
  /* ignore */
}

export function dataDir(): string {
  const dir = resolve(process.env.AI_SESSIONS_DATA_DIR || process.cwd());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function port(): number {
  const v = parseInt(process.env.AI_SESSIONS_PORT ?? "", 10);
  return Number.isFinite(v) ? v : 7878;
}
