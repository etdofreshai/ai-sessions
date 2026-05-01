import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import fg from "fast-glob";
import { startRun } from "../runs/start.js";
import { planAiSessionResolution } from "../ai-sessions/finalize.js";
import { buildCatalog } from "../skills/catalog.js";
import { outstandingJobsSection } from "../jobs/prompt-section.js";
import { subAgentPolicySection } from "../sub-agents/prompt-section.js";
import { loadDotenv } from "../sessions/dotenv.js";
import { sanitizeSubprocessEnv } from "./env-sanitize.js";
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
import { flattenContent } from "../sessions/content.js";

const claudeHome = () => process.env.CLAUDE_HOME || join(homedir(), ".claude");
const projectsDir = () => join(claudeHome(), "projects");

interface ClaudeEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
}

function guessImageMediaType(filename?: string, mimeType?: string): string {
  if (mimeType?.startsWith("image/")) return mimeType;
  const ext = (filename ?? "").toLowerCase().split(".").pop();
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "jpg":
    case "jpeg":
    default:
      return "image/jpeg";
  }
}

function buildClaudeContent(
  prompt: string,
  attachments?: import("./types.js").Attachment[]
): string | any[] {
  if (!attachments || attachments.length === 0) return prompt;
  const blocks: any[] = [];
  // Text first, then images and document references.
  if (prompt) blocks.push({ type: "text", text: prompt });
  const docPaths: string[] = [];
  for (const a of attachments) {
    if (a.kind === "image") {
      try {
        const data = readFileSync(a.path).toString("base64");
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: guessImageMediaType(a.filename, a.mimeType),
            data,
          },
        });
      } catch {
        docPaths.push(a.path);
      }
    } else {
      docPaths.push(a.path);
    }
  }
  if (docPaths.length) {
    const tail = docPaths.map((p) => `[Attached file: ${p}]`).join("\n");
    blocks.push({ type: "text", text: tail });
  }
  return blocks;
}

export interface ClaudeFlavorConfig {
  name: string;
  // Path to an extra settings file passed to the SDK as `settings: <path>`.
  // Used by GLM-style flavors that point Claude Code at a different
  // ANTHROPIC_BASE_URL etc. via a settings.json env block.
  settingsPath?: () => string | null;
  // Extra env vars layered on top of process.env + workspace .env. Rarely
  // needed — prefer settingsPath when possible, since claude-code respects
  // env blocks inside settings files natively.
  envOverlay?: () => Record<string, string> | null;
  // Stricter availability check. Defaults to checking that the claude
  // projects dir exists.
  isAvailable?: () => boolean | Promise<boolean>;
}

export function makeClaudeFlavoredProvider(cfg: ClaudeFlavorConfig): Provider {
  const providerName = cfg.name;
  return {
  name: providerName,

  async isAvailable() {
    if (cfg.isAvailable) return cfg.isAvailable();
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
        provider: providerName,
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
      provider: providerName,
      path,
      cwd,
      messageCount: messages.length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messages,
    };
  },

  run(opts: RunOptions): RunHandle {
    const yolo = opts.yolo ?? defaultYolo();
    const plan = planAiSessionResolution({
      provider: providerName,
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      asId: opts.aiSessionId,
      cwd: opts.cwd,
      internal: opts.internal,
    });
    const effectiveSessionId = plan.effectiveProviderSessionId;
    const effectiveCwd = plan.effectiveCwd;
    return startRun({
      provider: providerName,
      prompt: opts.prompt,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      yolo,
      internal: opts.internal,
      aiSessionId: plan.preResolvedAiSessionId,
      onFinalize: plan.attachToMeta,
      steerable: true,
      body: async ({ emit, onAbort, onSteer }) => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");

        // Build the first user-message content. Strings stay strings; runs
        // with attachments get a content array.
        const firstContent = buildClaudeContent(opts.prompt, opts.attachments);
        // Streaming pending queue: string for plain steers, content arrays for
        // anything richer.
        const pending: Array<string | any[]> = [firstContent];
        const closeSignal = { closed: false };
        type Resolver = () => void;
        let pushResolve: Resolver | null = null;

        async function* userStream(): AsyncGenerator<any, void, unknown> {
          while (true) {
            while (pending.length) {
              const content = pending.shift()!;
              yield {
                type: "user",
                message: { role: "user", content },
                parent_tool_use_id: null,
              };
            }
            if (closeSignal.closed) return;
            await new Promise<void>((r) => (pushResolve = r));
          }
        }

        onSteer?.((input: string) => {
          pending.push(input);
          if (pushResolve) {
            pushResolve();
            pushResolve = null;
          }
        });

        const skillsCatalog = effectiveCwd ? buildCatalog(effectiveCwd) : "";
        const jobsSection = outstandingJobsSection(plan.preResolvedAiSessionId);
        const subAgentSection = subAgentPolicySection(plan.preResolvedAiSessionId);
        const systemAppend = [skillsCatalog, jobsSection, subAgentSection]
          .filter(Boolean)
          .join("\n\n");
        const workspaceEnv = loadDotenv(effectiveCwd);
        const flavorEnv = cfg.envOverlay?.() ?? {};
        const flavorSettings = cfg.settingsPath?.() ?? null;
        if (cfg.name !== "claude") {
          console.error(`[${cfg.name}] settingsPath=${flavorSettings ?? "(none)"} envKeys=${Object.keys(flavorEnv).join(",")||"(none)"}`);
        }
        const stream = query({
          prompt: userStream(),
          options: {
            cwd: effectiveCwd,
            env: {
              ...sanitizeSubprocessEnv({ aiSessionId: plan.preResolvedAiSessionId }),
              ...workspaceEnv,
              ...flavorEnv,
            },
            ...(flavorSettings ? { settings: flavorSettings } : {}),
            ...(systemAppend
              ? {
                  systemPrompt: {
                    type: "preset" as const,
                    preset: "claude_code" as const,
                    append: systemAppend,
                  },
                }
              : {}),
            ...(yolo
              ? {
                  permissionMode: "bypassPermissions" as const,
                  allowDangerouslySkipPermissions: true,
                }
              : {}),
            // Override path to the claude CLI when set — needed in container
            // images where the agent-sdk's bundled native binary isn't
            // available (e.g. cross-libc lockfile). Falls back to the SDK's
            // own resolution when the env var is unset.
            ...(process.env.CLAUDE_CODE_EXECUTABLE
              ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE }
              : {}),
            ...(opts.effort ? { effort: opts.effort } : {}),
            ...(effectiveSessionId ? { resume: effectiveSessionId } : {}),
          },
        });

        onAbort(() => {
          stream.interrupt().catch(() => {});
          closeSignal.closed = true;
          if (pushResolve) {
            pushResolve();
            pushResolve = null;
          }
        });

        const chunks: string[] = [];
        let sessionId: string | undefined = effectiveSessionId;

        for await (const msg of stream as AsyncIterable<any>) {
          if (msg?.session_id && !sessionId) {
            const sid: string = String(msg.session_id);
            sessionId = sid;
            emit({ type: "session_id", sessionId: sid });
          }
          if (msg?.type === "assistant" && msg?.message?.content) {
            for (const block of msg.message.content as any[]) {
              if (block?.type === "text" && block.text) {
                chunks.push(block.text);
                emit({ type: "text", text: block.text });
              } else if (block?.type === "tool_use") {
                emit({
                  type: "tool_use",
                  name: String(block.name ?? "unknown"),
                  input: block.input,
                });
              } else if (block?.type === "tool_result") {
                emit({
                  type: "tool_result",
                  ...(block.name ? { name: String(block.name) } : {}),
                  output: block.content,
                });
              }
            }
          }
          if (msg?.type === "result") {
            // Result message arrived; signal end of input so the user-message
            // generator returns and the SDK closes cleanly.
            closeSignal.closed = true;
            if (pushResolve) {
              const r = pushResolve as Resolver;
              pushResolve = null;
              r();
            }
          }
        }

        return { output: chunks.join("\n"), sessionId };
      },
    });
  },
  };
}

export const claudeProvider: Provider = makeClaudeFlavoredProvider({ name: "claude" });
