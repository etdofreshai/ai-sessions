import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import { startRun } from "../runs/start.js";
import type { RunHandle } from "../runs/types.js";
import type {
  Provider,
  SessionSummary,
  SessionDetail,
  SessionMessage,
  RunOptions,
} from "./types.js";
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

  // NOTE: still using @openai/codex-sdk for now. Steer is unsupported on this
  // path; interrupt is best-effort via TurnOptions.signal. A follow-up commit
  // replaces this with direct `codex app-server` JSON-RPC for full feature
  // parity (steer + clean interrupt).
  run(opts: RunOptions): RunHandle {
    const yolo = opts.yolo ?? defaultYolo();
    return startRun({
      provider: "codex",
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      yolo,
      steerable: false,
      body: async ({ emit, onAbort }) => {
        const { Codex } = await import("@openai/codex-sdk");
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

        const ac = new AbortController();
        onAbort(() => ac.abort());

        const turn = await thread.run(opts.prompt, { signal: ac.signal });
        const output = turn.finalResponse;
        const sessionId = thread.id ?? opts.sessionId ?? undefined;
        if (sessionId) emit({ type: "session_id", sessionId });
        if (output) emit({ type: "text", text: output });
        return { output, sessionId };
      },
    });
  },
};
