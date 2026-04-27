import express from "express";
import type { Request, Response } from "express";
import { getProvider, listProviderNames, providers } from "../providers/index.js";
import { defaultYolo } from "../providers/types.js";
import { dataDir } from "../config.js";
import { openapi } from "./openapi.js";

// In-memory Codex thread registry — keyed by threadId (or temporary key until id is assigned).
const codexThreads = new Map<string, any>();
let codexClient: any | null = null;

async function getCodexClient() {
  if (codexClient) return codexClient;
  const { Codex } = await import("@openai/codex-sdk");
  codexClient = new Codex();
  return codexClient;
}

function defaultThreadOptions(yolo: boolean) {
  return yolo
    ? {
        sandboxMode: "danger-full-access" as const,
        approvalPolicy: "never" as const,
        skipGitRepoCheck: true,
      }
    : {};
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "ai-sessions",
      version: "0.1.0",
      yoloDefault: defaultYolo(),
      dataDir: dataDir(),
      docs: "/openapi.json",
      endpoints: Object.keys(openapi.paths),
    });
  });

  app.get("/openapi.json", (_req, res) => res.json(openapi));

  // Thin / unified routes
  app.get("/providers", async (_req, res) => {
    const out = await Promise.all(
      listProviderNames().map(async (name) => ({
        name,
        available: await providers[name].isAvailable(),
      }))
    );
    res.json(out);
  });

  app.get("/providers/:provider/sessions", async (req, res, next) => {
    try {
      res.json(await getProvider(req.params.provider).listSessions());
    } catch (e) {
      next(e);
    }
  });

  app.get("/providers/:provider/sessions/:id", async (req, res, next) => {
    try {
      res.json(await getProvider(req.params.provider).getSession(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.post("/providers/:provider/run", async (req, res, next) => {
    try {
      const { prompt, sessionId, cwd, yolo } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: "prompt required" });
      const result = await getProvider(req.params.provider).run({ prompt, sessionId, cwd, yolo });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // SDK-mirror: Claude
  app.post("/claude/query", async (req: Request, res: Response, next) => {
    try {
      const { prompt, options } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: "prompt required" });
      const yolo = options?.yolo ?? defaultYolo();
      const merged = {
        ...(yolo
          ? {
              permissionMode: "bypassPermissions" as const,
              allowDangerouslySkipPermissions: true,
            }
          : {}),
        ...options,
      };
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const stream = query({ prompt, options: merged }) as AsyncIterable<any>;

      if (req.query.stream === "1") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        for await (const msg of stream) {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
        }
        res.write("event: done\ndata: {}\n\n");
        res.end();
        return;
      }

      const messages: any[] = [];
      for await (const msg of stream) messages.push(msg);
      res.json({ messages });
    } catch (e) {
      next(e);
    }
  });

  // SDK-mirror: Codex
  app.post("/codex/threads", async (req, res, next) => {
    try {
      const { resumeId, threadOptions } = req.body ?? {};
      const yolo = req.body?.yolo ?? defaultYolo();
      const codex = await getCodexClient();
      const merged = { ...defaultThreadOptions(yolo), ...threadOptions };
      const thread = resumeId
        ? codex.resumeThread(resumeId, merged)
        : codex.startThread(merged);
      // thread.id is null until the first turn starts. Use resumeId or a temp key.
      const key = thread.id ?? resumeId ?? crypto.randomUUID();
      codexThreads.set(key, thread);
      res.json({ threadId: key, idAssigned: thread.id != null });
    } catch (e) {
      next(e);
    }
  });

  app.post("/codex/threads/:id/run", async (req, res, next) => {
    try {
      const { input, turnOptions } = req.body ?? {};
      if (!input) return res.status(400).json({ error: "input required" });
      const thread = codexThreads.get(req.params.id);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const turn = await thread.run(input, turnOptions);
      // After first run, thread.id becomes available — re-key under canonical id.
      if (thread.id && thread.id !== req.params.id) {
        codexThreads.delete(req.params.id);
        codexThreads.set(thread.id, thread);
      }
      res.json({ ...turn, threadId: thread.id ?? req.params.id });
    } catch (e) {
      next(e);
    }
  });

  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });

  return app;
}

export function startServer(port: number) {
  const app = createApp();
  return app.listen(port, () => {
    console.log(`ai-sessions API listening on http://localhost:${port}`);
    console.log(`docs: http://localhost:${port}/openapi.json`);
    console.log(`YOLO default: ${defaultYolo()}`);
    console.log(`data dir: ${dataDir()}`);
  });
}
