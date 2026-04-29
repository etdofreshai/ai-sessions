import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types.js";

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

// Reads the OAuth bearer from ~/.claude/.credentials.json. Returns null when
// the user is on a 1P API key (no OAuth) or the file doesn't exist.
export function readClaudeOAuth(): string | null {
  const p = join(process.env.CLAUDE_HOME || join(homedir(), ".claude"), ".credentials.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
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
