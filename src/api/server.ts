import express from "express";
import type { Request, Response } from "express";
import { getProvider, listProviderNames, providers } from "../providers/index.js";
import { defaultYolo } from "../providers/types.js";
import { dataDir } from "../config.js";
import {
  getLive,
  listRunIds,
  loadEvents,
  loadFromDisk,
} from "../runs/registry.js";
import * as aiStore from "../ai-sessions/store.js";
import {
  channels as channelRegistry,
  listChannelNames,
  startAvailableChannels,
} from "../channels/index.js";
import { openapi } from "./openapi.js";

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

  // Providers + sessions (unchanged shape).
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
      res.json(await getProvider(String(req.params.provider)).listSessions());
    } catch (e) {
      next(e);
    }
  });

  app.get("/providers/:provider/sessions/:id", async (req, res, next) => {
    try {
      res.json(await getProvider(String(req.params.provider)).getSession(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  // Unified runs API.
  app.post("/providers/:provider/runs", async (req: Request, res: Response, next) => {
    try {
      const { prompt, sessionId, aiSessionId, cwd, yolo } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: "prompt required" });

      const handle = getProvider(String(req.params.provider)).run({
        prompt,
        sessionId,
        aiSessionId,
        cwd,
        yolo,
      });

      const answerOnly = String(req.query.answerOnly ?? "") === "1";
      const noStream = String(req.query.stream ?? "") === "0" || answerOnly;

      if (noStream) {
        const meta = await handle.done;
        if (answerOnly) {
          res.type("text/plain").send(meta.output ?? "");
        } else {
          res.json(meta);
        }
        return;
      }

      // SSE by default.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`event: meta\ndata: ${JSON.stringify(handle.meta)}\n\n`);
      for await (const ev of handle.events) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      const final = await handle.done;
      res.write(`event: done\ndata: ${JSON.stringify(final)}\n\n`);
      res.end();
    } catch (e) {
      next(e);
    }
  });

  app.get("/providers/:provider/runs", (_req, res) => {
    res.json(listRunIds().map((id) => ({ runId: id })));
  });

  app.get("/providers/:provider/runs/:runId", (req, res) => {
    const live = getLive(req.params.runId);
    if (live) {
      res.json({ ...live.meta, live: true });
      return;
    }
    const meta = loadFromDisk(req.params.runId);
    if (!meta) return res.status(404).json({ error: "run not found" });
    res.json({ ...meta, live: false, events: loadEvents(req.params.runId) });
  });

  app.post("/providers/:provider/runs/:runId/interrupt", async (req, res) => {
    const live = getLive(req.params.runId);
    if (!live) return res.status(404).json({ error: "run not active" });
    await live.interrupt();
    res.json({ ok: true });
  });

  app.post("/providers/:provider/runs/:runId/steer", async (req, res) => {
    const live = getLive(req.params.runId);
    if (!live) return res.status(404).json({ error: "run not active" });
    if (!live.steer) {
      return res
        .status(501)
        .json({ error: `steer not supported by provider ${String(req.params.provider)}` });
    }
    const { input } = req.body ?? {};
    if (!input) return res.status(400).json({ error: "input required" });
    await live.steer(input);
    res.json({ ok: true });
  });

  // AiSession CRUD.
  app.get("/channels", async (_req, res) => {
    const out = await Promise.all(
      listChannelNames().map(async (name) => ({
        name,
        available: await channelRegistry[name].isAvailable(),
      }))
    );
    res.json(out);
  });

  app.get("/sessions", (_req, res) => {
    res.json(aiStore.list());
  });

  app.get("/sessions/:id", (req, res) => {
    const s = aiStore.read(req.params.id);
    if (!s) return res.status(404).json({ error: "ai-session not found" });
    res.json(s);
  });

  app.patch("/sessions/:id", (req, res) => {
    const s = aiStore.read(req.params.id);
    if (!s) return res.status(404).json({ error: "ai-session not found" });
    if (typeof req.body?.name === "string") s.name = req.body.name;
    aiStore.write(s);
    res.json(s);
  });

  app.delete("/sessions/:id", (req, res) => {
    const ok = aiStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "ai-session not found" });
    res.json({ ok: true });
  });

  // Fork an AiSession onto a different provider, seeded from the source.
  app.post("/sessions/:id/fork", async (req, res, next) => {
    try {
      const { forkAiSession } = await import("../ai-sessions/fork.js");
      const { targetProvider, destructive, cwd } = req.body ?? {};
      if (!targetProvider) {
        return res.status(400).json({ error: "targetProvider required" });
      }
      const result = await forkAiSession({
        sourceId: req.params.id,
        targetProvider,
        destructive: !!destructive,
        cwd,
      });
      res.json(result);
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
  const server = app.listen(port, () => {
    console.log(`ai-sessions API listening on http://localhost:${port}`);
    console.log(`docs: http://localhost:${port}/openapi.json`);
    console.log(`YOLO default: ${defaultYolo()}`);
    console.log(`data dir: ${dataDir()}`);
  });
  // Fire and forget — channels self-skip if not configured.
  void startAvailableChannels();
  return server;
}
