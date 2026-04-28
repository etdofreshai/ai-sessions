import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import fg from "fast-glob";
import { startRun } from "../runs/start.js";
import { planAiSessionResolution } from "../ai-sessions/finalize.js";
import { buildCatalog } from "../skills/catalog.js";
import { loadDotenv } from "../sessions/dotenv.js";
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
import { CodexAppServer } from "./codex-rpc.js";

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

  // Talks JSON-RPC NDJSON to `codex app-server` directly. Unlocks steer +
  // clean interrupt that the npm SDK doesn't expose.
  run(opts: RunOptions): RunHandle {
    const yolo = opts.yolo ?? defaultYolo();
    const plan = planAiSessionResolution({
      provider: "codex",
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      asId: opts.aiSessionId,
      cwd: opts.cwd,
      internal: opts.internal,
    });
    const effectiveSessionId = plan.effectiveProviderSessionId;
    const effectiveCwd = plan.effectiveCwd;
    return startRun({
      provider: "codex",
      prompt: opts.prompt,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      yolo,
      internal: opts.internal,
      aiSessionId: plan.preResolvedAiSessionId,
      onFinalize: plan.attachToMeta,
      steerable: true,
      body: async ({ emit, onAbort, onSteer }) => {
        const workspaceEnv = loadDotenv(effectiveCwd);
        const client = new CodexAppServer({
          cwd: effectiveCwd,
          env: { ...process.env, ...workspaceEnv },
        });
        try {
          await client.request("initialize", {
            clientInfo: {
              name: "ai-sessions",
              title: "ai-sessions",
              version: "0.1.0",
            },
          });

          const threadParams: Record<string, unknown> = {};
          if (effectiveCwd) threadParams.cwd = effectiveCwd;
          if (yolo) {
            threadParams.sandbox = "danger-full-access";
            threadParams.approvalPolicy = "never";
          }
          const skillsCatalog = effectiveCwd ? buildCatalog(effectiveCwd) : "";
          if (skillsCatalog) {
            threadParams.developer_instructions = skillsCatalog;
          }

          const threadResult: any = effectiveSessionId
            ? await client.request("thread/resume", {
                threadId: effectiveSessionId,
                ...threadParams,
              })
            : await client.request("thread/start", threadParams);

          const threadId: string =
            threadResult?.thread?.id ?? effectiveSessionId ?? "";
          if (threadId) emit({ type: "session_id", sessionId: threadId });

          // State across notifications for this turn.
          let turnId: string | null = null;
          let textOut = "";
          const turnDone = new Promise<{ status: string; error?: string }>((resolve) => {
            const unsubs: Array<() => void> = [];
            const cleanup = () => unsubs.forEach((fn) => fn());

            unsubs.push(
              client.on("turn/started", (p: any) => {
                const tid = p?.turn?.id ?? p?.turnId;
                if (tid && !turnId) turnId = tid;
              })
            );
            unsubs.push(
              client.on("item/agentMessage/delta", (p: any) => {
                if (p?.delta) {
                  textOut += p.delta;
                  emit({ type: "text", text: p.delta });
                }
              })
            );
            unsubs.push(
              client.on("item/completed", (p: any) => {
                const item = p?.item;
                if (!item) return;
                if (item.type === "agent_message" && item.text) {
                  if (!textOut) {
                    textOut = item.text;
                    emit({ type: "text", text: item.text });
                  }
                } else if (item.type === "command_execution") {
                  emit({
                    type: "tool_use",
                    name: "command_execution",
                    input: { command: item.command, status: item.status },
                  });
                } else if (item.type === "error") {
                  emit({ type: "error", message: item.message ?? "codex error" });
                }
              })
            );
            unsubs.push(
              client.on("error", (p: any) => {
                const msg = p?.error?.message;
                if (msg) emit({ type: "error", message: msg });
              })
            );
            unsubs.push(
              client.on("turn/completed", (p: any) => {
                cleanup();
                const status = p?.turn?.status ?? "completed";
                const error = p?.turn?.error?.message;
                resolve({ status, ...(error ? { error } : {}) });
              })
            );
            unsubs.push(
              client.on("turn/failed", (p: any) => {
                cleanup();
                resolve({
                  status: "failed",
                  error: p?.error?.message ?? "turn failed",
                });
              })
            );
          });

          // Build input items: text + any image attachments as local_image.
          // Document attachments get appended to the text as path references.
          const inputItems: any[] = [];
          const docPaths = (opts.attachments ?? [])
            .filter((a) => a.kind === "document")
            .map((a) => a.path);
          const textBody =
            opts.prompt +
            (docPaths.length
              ? "\n" + docPaths.map((p) => `[Attached file: ${p}]`).join("\n")
              : "");
          if (textBody) inputItems.push({ type: "text", text: textBody });
          for (const a of opts.attachments ?? []) {
            if (a.kind === "image") inputItems.push({ type: "local_image", path: a.path });
          }
          // Capture turnId from the response too (for steer/interrupt).
          const turnStartResultPromise = client
            .request("turn/start", {
              threadId,
              input: inputItems,
            })
            .then((res: any) => {
              if (res?.turn?.id && !turnId) turnId = res.turn.id;
              return res;
            })
            .catch((err: Error) => {
              emit({ type: "error", message: err.message });
              throw err;
            });

          onAbort(async () => {
            if (threadId && turnId) {
              try {
                await client.request("turn/interrupt", { threadId, turnId });
              } catch {
                /* best effort */
              }
            }
          });

          onSteer?.(async (input: string) => {
            if (!threadId || !turnId) return;
            try {
              await client.request("turn/steer", {
                threadId,
                expectedTurnId: turnId,
                input: [{ type: "text", text: input }],
              });
            } catch (e) {
              emit({
                type: "error",
                message: `steer failed: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          });

          await turnStartResultPromise;
          const final = await turnDone;
          // Top-level `error` notification already emitted the error event;
          // here we just propagate failure to the run framework.
          if (final.status === "failed") {
            throw new Error(final.error ?? "codex turn failed");
          }
          return { output: textOut, sessionId: threadId || undefined };
        } finally {
          await client.close();
        }
      },
    });
  },
};
