import type { UsageSnapshot, UsageWindow } from "./types.js";

// z.ai's GLM Coding Plan exposes usage via a monitoring endpoint that returns
// percentages for the 5-hour and weekly (and sometimes monthly) windows.
// Auth is the raw token — no "Bearer" prefix.
const ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";

export async function probeGlmQuota(token: string): Promise<UsageSnapshot> {
  const observedAt = new Date().toISOString();
  try {
    const resp = await fetch(ENDPOINT, {
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en",
        authorization: token,
      },
    });
    if (!resp.ok) {
      return {
        provider: "glm",
        windows: [],
        observedAt,
        error: `http_${resp.status}`,
      };
    }
    const j: any = await resp.json();
    // Schema isn't formally documented; the third-party plugin shows it
    // returns percent fields per window. Be permissive: pull anything that
    // looks like a percentage paired with a window name or reset time.
    const windows = extractWindows(j);
    const notes: string[] = [];
    if (windows.length === 0) {
      notes.push("z.ai response shape unrecognized");
      notes.push(`raw=${truncate(JSON.stringify(j), 400)}`);
    }
    return {
      provider: "glm",
      windows,
      notes: notes.length ? notes : undefined,
      observedAt,
    };
  } catch (e) {
    return {
      provider: "glm",
      windows: [],
      observedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// z.ai schema:
//   data.limits[]: { type: "TIME_LIMIT"|"TOKENS_LIMIT", percentage: <0..100>,
//                    nextResetTime: <epoch ms> }
// The fields naming the actual window length (`unit`/`number`) are opaque, so
// we infer from the distance to nextResetTime: <24h = "5h", <14d = "weekly",
// otherwise "monthly".
function extractWindows(j: any): UsageWindow[] {
  const limits: any[] = j?.data?.limits ?? [];
  const out: UsageWindow[] = [];
  const now = Date.now();
  for (const l of limits) {
    const pct = typeof l?.percentage === "number" ? l.percentage : null;
    const reset = typeof l?.nextResetTime === "number" ? new Date(l.nextResetTime) : null;
    if (pct == null && !reset) continue;
    let label = l?.type === "TIME_LIMIT" ? "time" : l?.type === "TOKENS_LIMIT" ? "tokens" : "limit";
    if (reset) {
      const hoursOut = (reset.getTime() - now) / 3600_000;
      if (hoursOut < 24) label = "5h";
      else if (hoursOut < 24 * 14) label = "weekly";
      else label = "monthly";
    }
    out.push({
      label,
      usedPct: pct ?? undefined,
      resetAt: reset?.toISOString(),
    });
  }
  return out;
}
