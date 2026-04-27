import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import type { Provider, SessionSummary, SessionDetail, SessionMessage, RunOptions, RunResult } from "./types.js";
import { defaultYolo } from "./types.js";
import { readJsonl, fileTimes } from "../sessions/jsonl.js";

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const sessionsDir = () => join(codexHome(), "sessions");

interface CodexEntry {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  payload?: { role?: string; content?: unknown };
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

function deriveId(path: string): string {
  // rollout files look like rollout-2026-04-27T12-34-56-<id>.jsonl
  const base = basename(path, ".jsonl");
  const idx = base.lastIndexOf("-");
  return idx > 0 ? base.slice(idx + 1) : base;
}

export const codexProvider: Provider = {
  name: "codex",

  async isAvailable() {
    return existsSync(sessionsDir());
  },

  async listSessions(): Promise<SessionSummary[]> {
    const dir = sessionsDir();
    if (!existsSync(dir)) return [];
    const files = await fg("**/*.jsonl", { cwd: dir, absolute: true });
    const out: SessionSummary[] = files.map((f) => {
      const t = fileTimes(f);
      return {
        id: deriveId(f),
        provider: "codex",
        path: f,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
    return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  },

  async getSession(id: string): Promise<SessionDetail> {
    const dir = sessionsDir();
    const all = await fg("**/*.jsonl", { cwd: dir, absolute: true });
    const path = all.find((p) => deriveId(p) === id || basename(p, ".jsonl") === id);
    if (!path) throw new Error(`codex session not found: ${id}`);
    const entries = await readJsonl<CodexEntry>(path);
    const messages: SessionMessage[] = [];
    for (const e of entries) {
      const role = e.role ?? e.payload?.role;
      const content = e.content ?? e.payload?.content;
      if (!role || content == null) continue;
      messages.push({
        role: role as SessionMessage["role"],
        content: flattenContent(content),
        timestamp: e.timestamp,
        raw: e,
      });
    }
    const t = fileTimes(path);
    return {
      id,
      provider: "codex",
      path,
      messageCount: messages.length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messages,
    };
  },

  async run(opts: RunOptions): Promise<RunResult> {
    const { Codex } = await import("@openai/codex-sdk");
    const yolo = opts.yolo ?? defaultYolo();
    const codex = new Codex();
    const threadOptions = {
      ...(opts.cwd ? { workingDirectory: opts.cwd } : {}),
      ...(yolo
        ? {
            sandboxMode: "danger-full-access" as const,
            approvalPolicy: "never" as const,
            skipGitRepoCheck: true,
          }
        : {}),
    };
    const thread = opts.sessionId
      ? codex.resumeThread(opts.sessionId, threadOptions)
      : codex.startThread(threadOptions);
    const turn = await thread.run(opts.prompt);
    const output = turn.finalResponse;
    if (output && opts.onChunk) opts.onChunk(output);
    return { sessionId: thread.id ?? opts.sessionId, output };
  },
};
