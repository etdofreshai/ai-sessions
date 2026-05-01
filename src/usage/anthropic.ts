import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types.js";

// Anthropic OAuth client_id used by claude-code (Console OAuth client).
// Documented in claude-code's own auth flow + several community auth shims.
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Refresh proactively when this close to expiry — gives the probe a small
// buffer instead of trying refresh-on-401 every time.
const REFRESH_LEAD_MS = 5 * 60 * 1000;

interface AnthropicProbeConfig {
  provider: string;
  baseUrl: string;
  authHeader: { name: string; value: string };
  model: string;
  // Extra headers required by the host (e.g. anthropic-version).
  extraHeaders?: Record<string, string>;
}

// Captures every anthropic-ratelimit-* header so we have raw evidence even
// when our parser doesn't know a particular variant yet.
function collectRateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith("anthropic-ratelimit-")) out[k.toLowerCase()] = v;
  });
  return out;
}

// Anthropic exposes two kinds of headers:
//   anthropic-ratelimit-unified-{5h,7d}-status / -reset
//      status = ok | allowed_warning | allowed_warning_strict | exceeded
//   anthropic-ratelimit-unified-{5h,7d}-utilization
//      0..1 fraction (sometimes 0..100). When present, this is what the user
//      actually wants to see as "% used".
// Anthropic returns reset as unix epoch seconds; older / variant headers may
// already be ISO. Normalize to ISO so callers can format consistently.
function parseResetValue(v: string): string {
  const n = Number(v);
  if (Number.isFinite(n) && n > 1_000_000_000) {
    return new Date(n * 1000).toISOString();
  }
  return v;
}

function parseUnifiedWindow(
  raw: Record<string, string>,
  label: string,
  prefix: string
): UsageWindow | null {
  const statusKey = `${prefix}-status`;
  const resetKey = `${prefix}-reset`;
  const utilKey = `${prefix}-utilization`;
  if (!(statusKey in raw) && !(utilKey in raw) && !(resetKey in raw)) return null;
  const w: UsageWindow = { label };
  if (raw[statusKey]) w.status = raw[statusKey];
  if (raw[resetKey]) w.resetAt = parseResetValue(raw[resetKey]);
  if (raw[utilKey]) {
    const n = Number(raw[utilKey]);
    if (Number.isFinite(n)) w.usedPct = n <= 1 ? n * 100 : n;
  }
  return w;
}

export async function probeAnthropic(cfg: AnthropicProbeConfig): Promise<UsageSnapshot> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    [cfg.authHeader.name]: cfg.authHeader.value,
    ...(cfg.extraHeaders ?? {}),
  };
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: 1,
    messages: [{ role: "user", content: "hi" }],
  });
  const resp = await fetch(url, { method: "POST", headers, body });
  const raw = collectRateLimitHeaders(resp.headers);
  const windows: UsageWindow[] = [];
  const w5 = parseUnifiedWindow(raw, "5h", "anthropic-ratelimit-unified-5h");
  const w7 = parseUnifiedWindow(raw, "7d", "anthropic-ratelimit-unified-7d");
  if (w5) windows.push(w5);
  if (w7) windows.push(w7);

  const notes: string[] = [];
  if (Object.keys(raw).length === 0) {
    notes.push("no anthropic-ratelimit-* headers returned");
  }
  if (!resp.ok) {
    notes.push(`probe HTTP ${resp.status}`);
  }

  return {
    provider: cfg.provider,
    windows,
    notes: notes.length ? notes : undefined,
    observedAt: new Date().toISOString(),
  };
}

function credentialsPath(): string {
  return join(
    process.env.CLAUDE_HOME || join(homedir(), ".claude"),
    ".credentials.json",
  );
}

interface ClaudeOAuthRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function readClaudeOAuthRecord(): ClaudeOAuthRecord | null {
  const p = credentialsPath();
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const oauth = j?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    };
  } catch {
    return null;
  }
}

// Legacy compat — anyone importing the old name still gets a string.
export function readClaudeOAuth(): string | null {
  return readClaudeOAuthRecord()?.accessToken ?? null;
}

function writeClaudeOAuth(updated: {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}): void {
  const p = credentialsPath();
  let existing: any = {};
  try {
    existing = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* file may be missing on the first write */
  }
  const merged = {
    ...existing,
    claudeAiOauth: {
      ...(existing?.claudeAiOauth ?? {}),
      accessToken: updated.accessToken,
      refreshToken:
        updated.refreshToken ?? existing?.claudeAiOauth?.refreshToken,
      expiresAt: updated.expiresAt,
    },
  };
  // Atomic write so claude-code (which also reads this file) never sees a
  // half-written JSON.
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, p);
}

// POST /v1/oauth/token with grant_type=refresh_token. Returns a fresh
// access_token + the refresh_token Anthropic gives back (sometimes the same,
// sometimes rotated). Writes the result back to .credentials.json so
// subsequent probes (and claude-code itself) pick up the new tokens.
async function refreshClaudeOAuth(refreshToken: string): Promise<ClaudeOAuthRecord> {
  const resp = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`oauth refresh failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const j = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!j.access_token) throw new Error("oauth refresh response missing access_token");
  const expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
  writeClaudeOAuth({
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt,
  });
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? refreshToken,
    expiresAt,
  };
}

// Read the OAuth record, refresh if expired or close to it, and return the
// (now-fresh) access token. Caller passes a `notes` array we can drop a
// human-readable note into when the refresh ran or failed — it shows up in
// the /usage snapshot output so users can tell why a probe took longer
// than usual or why it errored.
export async function getFreshClaudeBearer(notes: string[]): Promise<string | null> {
  const rec = readClaudeOAuthRecord();
  if (!rec) return null;
  const expiringSoon =
    typeof rec.expiresAt === "number" && rec.expiresAt - Date.now() < REFRESH_LEAD_MS;
  if (!expiringSoon) return rec.accessToken;
  if (!rec.refreshToken) {
    notes.push("oauth token near/expired and no refresh_token in .credentials.json");
    return rec.accessToken;
  }
  try {
    const refreshed = await refreshClaudeOAuth(rec.refreshToken);
    notes.push(`oauth refreshed; new expiresAt=${new Date(refreshed.expiresAt!).toISOString()}`);
    return refreshed.accessToken;
  } catch (e: any) {
    notes.push(`oauth refresh failed: ${e?.message ?? e}`);
    return rec.accessToken; // try the stale token anyway
  }
}

// Reads ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL from settings-glm.json so we
// know where to point the GLM probe. Returns null if the file isn't present.
export function readGlmAuth(): { token: string; baseUrl: string; model: string } | null {
  const path =
    process.env.AI_SESSIONS_GLM_SETTINGS ||
    join(process.env.CLAUDE_HOME || join(homedir(), ".claude"), "settings-glm.json");
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const env = j?.env ?? {};
    if (!env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL) return null;
    return {
      token: env.ANTHROPIC_AUTH_TOKEN,
      baseUrl: env.ANTHROPIC_BASE_URL,
      model: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || "glm-5.1",
    };
  } catch {
    return null;
  }
}
