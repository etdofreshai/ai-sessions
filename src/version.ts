import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

// Resolve the running build's git SHA + branch. Priority:
//   1. /app/BUILD_SHA (baked by Dockerfile from .git in the build context).
//      Same dir is checked relative to dist/ for dev builds run from /app.
//   2. AI_SESSIONS_GIT_SHA env (manual override / CI build-arg path).
//   3. `git` invoked in the cwd (works in dev / when .git is present).
//   4. "(unknown)" fallback.
function detect(): { sha: string; shortSha: string; branch: string } {
  // Look for BUILD_SHA next to the running process. The Dockerfile writes
  // it to /app/BUILD_SHA; in dev (tsx src/cli.ts), cwd is the repo root,
  // so we'd never find it there — that's fine, the next fallback handles
  // dev via runtime git.
  const buildShaCandidates: string[] = [];
  buildShaCandidates.push(resolve("BUILD_SHA"));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    buildShaCandidates.push(join(here, "..", "BUILD_SHA"));
    buildShaCandidates.push(join(here, "..", "..", "BUILD_SHA"));
  } catch {
    /* ignore */
  }
  for (const p of buildShaCandidates) {
    if (!existsSync(p)) continue;
    try {
      const sha = readFileSync(p, "utf8").trim();
      if (!sha) break;
      let branch = "(build)";
      const branchPath = p.replace(/BUILD_SHA$/, "BUILD_BRANCH");
      if (existsSync(branchPath)) {
        branch = readFileSync(branchPath, "utf8").trim() || branch;
      }
      return { sha, shortSha: sha.slice(0, 7), branch };
    } catch {
      /* keep trying */
    }
  }

  const fromEnv = process.env.AI_SESSIONS_GIT_SHA;
  const branchEnv = process.env.AI_SESSIONS_GIT_BRANCH;
  if (fromEnv) {
    return {
      sha: fromEnv,
      shortSha: fromEnv.slice(0, 7),
      branch: branchEnv ?? "(env)",
    };
  }
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    return { sha, shortSha: sha.slice(0, 7), branch };
  } catch {
    return { sha: "(unknown)", shortSha: "unknown", branch: "(unknown)" };
  }
}

export const GIT = detect();
