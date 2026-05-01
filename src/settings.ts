import { db } from "./db/index.js";

// Tiny app-wide key/value store. Use sparingly — most state belongs on a
// specific AiSession, provider, or job row. Settings are runtime toggles
// that aren't naturally per-anything (e.g. "should /skills advertise each
// skill as a Telegram slash command?").

export function getSetting(key: string): string | null {
  const row = db().prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db().prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getBoolSetting(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  if (v === null) return fallback;
  return v === "1" || v === "true";
}

export function setBoolSetting(key: string, value: boolean): void {
  setSetting(key, value ? "1" : "0");
}
