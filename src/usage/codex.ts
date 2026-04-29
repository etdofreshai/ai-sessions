import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types.js";

// The Codex CLI itself polls /backend-api/wham/usage every 60s using the
// chatgpt-account-id + Bearer access_token from ~/.codex/auth.json. The
// response contains primary (5h) and secondary (7d) rate-limit windows with
// percent used + reset timestamps — exactly what we want to surface.
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

function readCodexAuth(): CodexAuth | null {
  const p = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const accessToken: string | undefined = j?.tokens?.access_token;
    if (!accessToken) return null;
    // Prefer the account_id from auth.json; otherwise pull chatgpt_user_id
    // from the id_token claims (codex-cli does the same).
    let accountId: string | undefined = j?.tokens?.account_id;
    if (!accountId && typeof j?.tokens?.id_token === "string") {
      try {
        const payload = j.tokens.id_token.split(".")[1];
        const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
        accountId = decoded?.["https://api.openai.com/auth"]?.chatgpt_user_id;
      } catch {
        /* ignore */
      }
    }
    if (!accountId) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function windowFromCodex(label: string, w: any): UsageWindow | null {
  if (!w) return null;
  const out: UsageWindow = { label };
  if (typeof w.used_percent === "number") out.usedPct = w.used_percent;
  if (typeof w.reset_at === "number") out.resetAt = new Date(w.reset_at * 1000).toISOString();
  else if (typeof w.reset_after_seconds === "number")
    out.resetAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  return out;
}

export async function probeCodex(): Promise<UsageSnapshot> {
  const observedAt = new Date().toISOString();
  const auth = readCodexAuth();
  if (!auth) {
    return {
      provider: "codex",
      windows: [],
      observedAt,
      error: "no_credentials",
      notes: ["~/.codex/auth.json missing tokens.access_token or account id"],
    };
  }

  try {
    const resp = await fetch(USAGE_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        // Cloudflare in front of chatgpt.com 403s generic clients; mimic the
        // CLI's user-agent string.
        "user-agent": "codex_cli_rs/0.50.0",
      },
    });
    if (!resp.ok) {
      return {
        provider: "codex",
        windows: [],
        observedAt,
        error: `http_${resp.status}`,
      };
    }
    const j: any = await resp.json();
    const rl = j?.rate_limit ?? {};
    const windows: UsageWindow[] = [];
    const primary = windowFromCodex("5h", rl.primary_window);
    const secondary = windowFromCodex("7d", rl.secondary_window);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    return {
      provider: "codex",
      windows,
      observedAt,
    };
  } catch (e) {
    return {
      provider: "codex",
      windows: [],
      observedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
