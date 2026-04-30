import type { AiSession } from "../ai-sessions/types.js";
import type { SessionDetail } from "../providers/types.js";

export interface TraceEvent {
  ts: number;
  type: "tool_use" | "tool_result" | "error";
  name?: string;
  input?: unknown;
  output?: unknown;
  message?: string;
}

export interface TraceRecord {
  source: "route" | "agent" | "btw";
  label?: string;
  prompt: string;
  startedAt: number;
  finishedAt?: number;
  events: TraceEvent[];
  finalText?: string;
}

// Single-line preview of a tool's input — used in status bubbles.
export function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.split(/\r?\n/)[0].slice(0, 60);
  try {
    const s = JSON.stringify(input);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return "";
  }
}

export function safeStringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function stringifyOutput(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return safeStringify(v);
}

export function renderTraceMarkdown(trace: TraceRecord): string {
  const lines: string[] = [];
  const dur = trace.finishedAt
    ? `${((trace.finishedAt - trace.startedAt) / 1000).toFixed(1)}s`
    : `${((Date.now() - trace.startedAt) / 1000).toFixed(1)}s (in progress)`;
  lines.push(`# Trace — ${trace.source}${trace.label ? ` (${trace.label})` : ""}`);
  lines.push("");
  lines.push(`- Started: ${new Date(trace.startedAt).toISOString()}`);
  lines.push(`- Duration: ${dur}`);
  lines.push(`- Events: ${trace.events.length}`);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push("```");
  lines.push(trace.prompt);
  lines.push("```");
  lines.push("");
  lines.push("## Events");
  lines.push("");
  for (let i = 0; i < trace.events.length; i++) {
    const ev = trace.events[i];
    const t = `+${((ev.ts - trace.startedAt) / 1000).toFixed(1)}s`;
    if (ev.type === "tool_use") {
      lines.push(`### ${i + 1}. 🔧 ${ev.name ?? "tool"} (${t})`);
      lines.push("");
      lines.push("```json");
      lines.push(safeStringify(ev.input));
      lines.push("```");
    } else if (ev.type === "tool_result") {
      lines.push(`### ${i + 1}. ✓ ${ev.name ?? "tool result"} (${t})`);
      lines.push("");
      lines.push("```");
      lines.push(stringifyOutput(ev.output));
      lines.push("```");
    } else if (ev.type === "error") {
      lines.push(`### ${i + 1}. ❌ error (${t})`);
      lines.push("");
      lines.push("```");
      lines.push(ev.message ?? "");
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("## Response");
  lines.push("");
  lines.push(trace.finalText ?? "(in progress)");
  return lines.join("\n");
}

// Heuristic: did this provider error look like the prompt blew the context
// window? Capped to short messages so a stack trace mentioning "context"
// doesn't trip it. Used to decide whether to summarize-and-retry.
export function isContextOverflow(message: string | null | undefined): boolean {
  if (!message) return false;
  if (message.length > 500) return false;
  const m = message.toLowerCase();
  return (
    m.includes("prompt is too long") ||
    m.includes("input is too long") ||
    m.includes("context length") ||
    m.includes("token limit") ||
    m.includes("max_tokens") ||
    m.includes("too many tokens")
  );
}

export function shortStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderTranscriptMarkdown(ai: AiSession, detail: SessionDetail): string {
  const header = [
    `# ${ai.name ?? "(unnamed)"}`,
    "",
    `- Session: \`${ai.id}\``,
    `- Provider: ${ai.provider}`,
    `- Provider session: \`${ai.sessionId ?? ""}\``,
    `- cwd: ${ai.cwd ?? "(unset)"}`,
    `- Messages: ${detail.messages.length}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].join("\n");
  const body = detail.messages
    .map((m) => {
      const ts = m.timestamp ? ` _(${m.timestamp})_` : "";
      return `## ${m.role}${ts}\n\n${m.content}\n`;
    })
    .join("\n");
  return header + body;
}

export function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
