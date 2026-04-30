import { execSync } from "node:child_process";

export const VERSION = "0.1.0";

// Resolve the running build's git SHA + branch. Priority:
//   1. AI_SESSIONS_GIT_SHA / AI_SESSIONS_GIT_BRANCH env (baked at image build).
//   2. `git` invoked in the cwd at startup (works in dev / when .git is present).
//   3. "(unknown)" fallback.
function detect(): { sha: string; shortSha: string; branch: string } {
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
