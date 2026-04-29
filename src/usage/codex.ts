import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow } from "./types.js";

// Codex (chatgpt auth mode) routes through ChatGPT's backend, not the public
// OpenAI API — `x-ratelimit-*` headers from api.openai.com don't apply, and
// there's no documented usage endpoint. Best-effort: if the user is on a raw
// OPENAI_API_KEY, hit the public API; otherwise return an unsupported note.
export async function probeCodex(): Promise<UsageSnapshot> {
  const authPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  let mode = "unknown";
  let openaiKey: string | null = null;
  if (existsSync(authPath)) {
    try {
      const j = JSON.parse(readFileSync(authPath, "utf8"));
      mode = j?.auth_mode ?? "unknown";
      openaiKey = j?.OPENAI_API_KEY ?? null;
    } catch {
      /* ignore */
    }
  }

  const observedAt = new Date().toISOString();

  if (mode === "chatgpt" && !openaiKey) {
    return {
      provider: "codex",
      windows: [],
      notes: [
        "codex is using ChatGPT auth (Plus/Pro/Team) — usage windows are not exposed via API",
        "5h and weekly limits are tracked server-side; visible only inside the codex CLI itself",
      ],
      observedAt,
    };
  }

  if (!openaiKey) {
    return {
      provider: "codex",
      windows: [],
      notes: ["no OPENAI_API_KEY found in ~/.codex/auth.json"],
      observedAt,
      error: "no_credentials",
    };
  }

  // Public OpenAI API path: a tiny chat.completions probe surfaces standard
  // x-ratelimit-* headers we can convert into a single rolling window.
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const limit = Number(resp.headers.get("x-ratelimit-limit-requests"));
    const remaining = Number(resp.headers.get("x-ratelimit-remaining-requests"));
    const reset = resp.headers.get("x-ratelimit-reset-requests");
    const windows: UsageWindow[] = [];
    if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
      windows.push({
        label: "rpm",
        usedPct: ((limit - remaining) / limit) * 100,
        resetAt: reset ?? undefined,
      });
    }
    return {
      provider: "codex",
      windows,
      notes: windows.length ? undefined : ["no x-ratelimit-* headers returned"],
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
