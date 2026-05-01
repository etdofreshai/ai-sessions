import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import fg from "fast-glob";
import { startRun } from "../runs/start.js";
import { planAiSessionResolution } from "../ai-sessions/finalize.js";
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

const opencodeHome = () =>
  process.env.OPENCODE_HOME || join(homedir(), ".local", "share", "opencode");

export const opencodeProvider: Provider = {
  name: "opencode",

  async isAvailable() {
    return existsSync(opencodeHome());
  },

  async listSessions(): Promise<SessionSummary[]> {
    const root = opencodeHome();
    if (!existsSync(root)) return [];
    const files = await fg(["**/session/**/*.json", "**/sessions/**/*.json", "**/*.jsonl"], {
      cwd: root,
      absolute: true,
    });
    return files
      .map((f) => {
        const t = fileTimes(f);
        return {
          id: basename(f).replace(/\.(json|jsonl)$/, ""),
          provider: "opencode",
          path: f,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        } satisfies SessionSummary;
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  },

  async getSession(id: string): Promise<SessionDetail> {
    const sessions = await this.listSessions();
    const match = sessions.find((s) => s.id === id);
    if (!match) throw new Error(`opencode session not found: ${id}`);
    const messages: SessionMessage[] = [];
    if (match.path.endsWith(".jsonl")) {
      const entries = await readJsonl<any>(match.path);
      for (const e of entries) {
        const role = e?.role ?? e?.message?.role;
        const content = e?.content ?? e?.message?.content;
        if (!role) continue;
        messages.push({
          role: role as SessionMessage["role"],
          content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
          timestamp: e?.timestamp,
          raw: e,
        });
      }
    }
    return { ...match, messages, messageCount: messages.length };
  },

  run(opts: RunOptions): RunHandle {
    const yolo = opts.yolo ?? defaultYolo();
    const plan = planAiSessionResolution({
      provider: "opencode",
      prompt: opts.prompt,
      sessionId: opts.sessionId,
      asId: opts.aiSessionId,
      cwd: opts.cwd,
      internal: opts.internal,
    });
    const effectiveSessionId = plan.effectiveProviderSessionId;
    const effectiveCwd = plan.effectiveCwd;
    return startRun({
      provider: "opencode",
      prompt: opts.prompt,
      sessionId: effectiveSessionId,
      cwd: effectiveCwd,
      yolo,
      internal: opts.internal,
      aiSessionId: plan.preResolvedAiSessionId,
      onFinalize: plan.attachToMeta,
      steerable: false,
      body: async ({ emit, onAbort }) => {
        const attachLines = (opts.attachments ?? []).map(
          (a) => `[Attached file: ${a.path}]`
        );
        const fullPrompt = attachLines.length
          ? `${opts.prompt}\n${attachLines.join("\n")}`
          : opts.prompt;
        const args = ["run", fullPrompt];
        if (effectiveSessionId) args.push("--session", effectiveSessionId);
        if (yolo) args.push("--yolo");
        // opencode calls reasoning effort "variant"; values are provider-
        // specific (e.g. low/medium/high/xhigh for OpenAI). Pass through
        // verbatim — if the underlying model doesn't accept it, opencode
        // will surface the error.
        if (opts.effort) args.push("--variant", opts.effort);

        return new Promise<{ output: string; sessionId?: string }>((resolve, reject) => {
          const workspaceEnv = loadDotenv(effectiveCwd);
          const child = spawn("opencode", args, {
            cwd: effectiveCwd,
            env: sanitizeSubprocessEnv(
              { aiSessionId: plan.preResolvedAiSessionId },
              { ...(process.env as Record<string, string | undefined>), ...workspaceEnv },
            ),
            stdio: ["ignore", "pipe", "pipe"],
            shell: process.platform === "win32",
          });
          onAbort(() => {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => {
            const s = d.toString();
            out += s;
            emit({ type: "text", text: s });
          });
          child.stderr.on("data", (d) => (err += d.toString()));
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0 && code !== null) {
              reject(new Error(`opencode exited ${code}: ${err}`));
            } else {
              resolve({ output: out, sessionId: effectiveSessionId });
            }
          });
        });
      },
    });
  },
};
