import * as store from "./store.js";
import { probeAnthropic, getFreshClaudeBearer, readGlmAuth } from "./anthropic.js";
import { probeGlmQuota } from "./glm.js";
import { probeCodex } from "./codex.js";
import type { UsageSnapshot } from "./types.js";

const FRESH_MS = 60_000;

async function probe(provider: string): Promise<UsageSnapshot> {
  if (provider === "claude") {
    const refreshNotes: string[] = [];
    const tok = await getFreshClaudeBearer(refreshNotes);
    if (!tok) {
      return {
        provider,
        windows: [],
        observedAt: new Date().toISOString(),
        error: "no_oauth_token",
        notes: [
          "~/.claude/.credentials.json not found or missing claudeAiOauth.accessToken",
          ...refreshNotes,
        ],
      };
    }
    const snap = await probeAnthropic({
      provider,
      baseUrl: "https://api.anthropic.com",
      authHeader: { name: "authorization", value: `Bearer ${tok}` },
      model: "claude-haiku-4-5-20251001",
      extraHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
    if (refreshNotes.length) {
      snap.notes = [...refreshNotes, ...(snap.notes ?? [])];
    }
    return snap;
  }

  if (provider === "glm") {
    const cfg = readGlmAuth();
    if (!cfg) {
      return {
        provider,
        windows: [],
        observedAt: new Date().toISOString(),
        error: "no_glm_settings",
      };
    }
    return probeGlmQuota(cfg.token);
  }

  if (provider === "codex") {
    return probeCodex();
  }

  return {
    provider,
    windows: [],
    observedAt: new Date().toISOString(),
    error: "unsupported_provider",
  };
}

export async function getUsage(
  provider: string,
  opts: { force?: boolean } = {}
): Promise<UsageSnapshot> {
  if (!opts.force) {
    const cached = store.read(provider);
    if (cached && Date.now() - new Date(cached.observedAt).getTime() < FRESH_MS) {
      return cached;
    }
  }
  let snap: UsageSnapshot;
  try {
    snap = await probe(provider);
  } catch (e) {
    const cached = store.read(provider);
    snap = cached
      ? { ...cached, stale: true, error: e instanceof Error ? e.message : String(e) }
      : {
          provider,
          windows: [],
          observedAt: new Date().toISOString(),
          error: e instanceof Error ? e.message : String(e),
        };
  }
  store.write(snap);
  return snap;
}

export function formatUsage(snap: UsageSnapshot, tz = "America/Chicago"): string {
  const lines: string[] = [`${snap.provider}:`];
  if (snap.error) lines.push(`  error: ${snap.error}`);
  if (snap.stale) lines.push(`  (stale)`);
  if (snap.windows.length === 0 && !snap.error) {
    lines.push("  no usage data available");
  }
  for (const w of snap.windows) {
    const used = w.usedPct != null ? `${w.usedPct.toFixed(1)}% used` : "?";
    const remaining = w.usedPct != null ? `${(100 - w.usedPct).toFixed(1)}% left` : "";
    const reset = w.resetAt ? formatLocal(w.resetAt, tz) : "";
    const status = w.status ? ` [${w.status}]` : "";
    lines.push(`  ${w.label}: ${used}${remaining ? ` (${remaining})` : ""}${reset ? `  resets ${reset}` : ""}${status}`);
  }
  if (snap.notes) for (const n of snap.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

function formatLocal(iso: string, tz: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}
