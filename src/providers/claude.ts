import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import type { Provider, SessionSummary, SessionDetail, SessionMessage, RunOptions, RunResult } from "./types.js";
import { defaultYolo } from "./types.js";
import { readJsonl, fileTimes } from "../sessions/jsonl.js";

const claudeHome = () => process.env.CLAUDE_HOME || join(homedir(), ".claude");
const projectsDir = () => join(claudeHome(), "projects");

interface ClaudeEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

export const claudeProvider: Provider = {
  name: "claude",

  async isAvailable() {
    return existsSync(projectsDir());
  },

  async listSessions(): Promise<SessionSummary[]> {
    const dir = projectsDir();
    if (!existsSync(dir)) return [];
    const files = await fg("**/*.jsonl", { cwd: dir, absolute: true });
    const out: SessionSummary[] = [];
    for (const f of files) {
      const id = basename(f, ".jsonl");
      const t = fileTimes(f);
      out.push({
        id,
        provider: "claude",
        path: f,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      });
    }
    return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  },

  async getSession(id: string): Promise<SessionDetail> {
    const dir = projectsDir();
    const matches = await fg(`**/${id}.jsonl`, { cwd: dir, absolute: true });
    if (matches.length === 0) throw new Error(`claude session not found: ${id}`);
    const path = matches[0];
    const entries = await readJsonl<ClaudeEntry>(path);
    const messages: SessionMessage[] = [];
    let cwd: string | undefined;
    for (const e of entries) {
      if (e.cwd && !cwd) cwd = e.cwd;
      const role = e.message?.role;
      if (!role) continue;
      messages.push({
        role: (role as SessionMessage["role"]) ?? "assistant",
        content: flattenContent(e.message?.content),
        timestamp: e.timestamp,
        raw: e,
      });
    }
    const t = fileTimes(path);
    return {
      id,
      provider: "claude",
      path,
      cwd,
      messageCount: messages.length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messages,
    };
  },

  async run(opts: RunOptions): Promise<RunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const chunks: string[] = [];
    let sessionId: string | undefined = opts.sessionId;
    const yolo = opts.yolo ?? defaultYolo();
    const stream = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        ...(yolo
          ? {
              permissionMode: "bypassPermissions" as const,
              allowDangerouslySkipPermissions: true,
            }
          : {}),
        ...(opts.sessionId ? { resume: opts.sessionId } : {}),
      },
    });
    for await (const msg of stream as AsyncIterable<any>) {
      if (msg?.session_id && !sessionId) sessionId = msg.session_id;
      if (msg?.type === "assistant" && msg?.message?.content) {
        const text = flattenContent(msg.message.content);
        chunks.push(text);
        opts.onChunk?.(text);
      }
    }
    return { sessionId, output: chunks.join("\n") };
  },
};
