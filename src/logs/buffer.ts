// In-memory ring buffer of recent server log lines, fed by patched
// console.{log,warn,error}. The /logs endpoint exposes the tail so the
// dashboard can show what would normally only be visible in the
// terminal where `ais serve` runs.
//
// Capacity is intentionally small (a few thousand lines) — this is a
// peek tool, not a SIEM. For deeper history, use docker logs / dokploy.

const CAPACITY = 4000;

export interface LogLine {
  ts: string;
  level: "log" | "warn" | "error";
  text: string;
}

const buf: LogLine[] = [];
let installed = false;

export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  const wrap = (level: LogLine["level"], orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        const text = args
          .map((a) => {
            if (typeof a === "string") return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          })
          .join(" ");
        push({ ts: new Date().toISOString(), level, text });
      } catch {
        /* never throw from a logger wrapper */
      }
      orig.apply(console, args);
    };

  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  c.log = wrap("log",   c.log.bind(console));
  c.warn = wrap("warn", c.warn.bind(console));
  c.error = wrap("error", c.error.bind(console));
}

function push(line: LogLine): void {
  buf.push(line);
  if (buf.length > CAPACITY) buf.splice(0, buf.length - CAPACITY);
}

export function tail(limit = 500): LogLine[] {
  if (limit >= buf.length) return buf.slice();
  return buf.slice(buf.length - limit);
}

export function size(): number {
  return buf.length;
}
