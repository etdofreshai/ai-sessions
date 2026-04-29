export interface UsageWindow {
  // Free-form label e.g. "5h", "7d", "1mo".
  label: string;
  // Percentage *used*, 0-100. Provider may only give "remaining" — we convert.
  usedPct?: number;
  // ISO timestamp of when this window resets.
  resetAt?: string;
  // Server-reported status when available: ok | allowed_warning | exceeded.
  status?: string;
}

export interface UsageSnapshot {
  provider: string;
  windows: UsageWindow[];
  // Anything provider-specific the probe wants to surface.
  notes?: string[];
  observedAt: string;
  // Set when the probe couldn't pull live data — last cached snapshot will
  // still be returned but flagged.
  stale?: boolean;
  error?: string;
}
