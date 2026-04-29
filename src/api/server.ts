import express from "express";
import type { Request, Response } from "express";
import { getProvider, listProviderNames, providers } from "../providers/index.js";
import { defaultYolo } from "../providers/types.js";
import { dataDir, workspaceDir } from "../config.js";
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
import * as cronStore from "../crons/store.js";
import { makeJob, nextFireAfter } from "../crons/scheduler.js";
import { getUsage } from "../usage/index.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "ai-sessions",
      version: "0.1.0",
      yoloDefault: defaultYolo(),
      dataDir: dataDir(),
      workspaceDir: workspaceDir(),
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

  app.get("/crons", (_req, res) => {
    res.json(cronStore.list());
  });

  app.get("/crons/:name", (req, res) => {
    const j = cronStore.read(req.params.name);
    if (!j) return res.status(404).json({ error: "cron not found" });
    res.json(j);
  });

  app.post("/crons", (req, res) => {
    const { name, cron, target, timezone, missedPolicy } = req.body ?? {};
    if (!name || !cron || !target?.kind) {
      return res.status(400).json({ error: "name, cron, target.kind required" });
    }
    const job = makeJob({ name, cron, target, timezone, missedPolicy });
    cronStore.write(job);
    res.json(job);
  });

  app.patch("/crons/:name", (req, res) => {
    const j = cronStore.read(req.params.name);
    if (!j) return res.status(404).json({ error: "cron not found" });
    const { enabled, cron, target, timezone, missedPolicy } = req.body ?? {};
    if (typeof enabled === "boolean") j.enabled = enabled;
    if (typeof cron === "string") j.cron = cron;
    if (target) j.target = target;
    if (typeof timezone === "string") j.timezone = timezone;
    if (missedPolicy) j.missedPolicy = missedPolicy;
    j.nextRunAt = nextFireAfter(j.cron, new Date(), j.timezone).toISOString();
    cronStore.write(j);
    res.json(j);
  });

  app.delete("/crons/:name", (req, res) => {
    const ok = cronStore.remove(req.params.name);
    if (!ok) return res.status(404).json({ error: "cron not found" });
    res.json({ ok: true });
  });

  app.get("/usage", async (req, res, next) => {
    try {
      const force = String(req.query.force ?? "") === "1";
      const targets = ["claude", "glm", "codex"];
      const snaps = await Promise.all(targets.map((p) => getUsage(p, { force })));
      res.json(snaps);
    } catch (e) {
      next(e);
    }
  });

  app.get("/usage/:provider", async (req, res, next) => {
    try {
      const force = String(req.query.force ?? "") === "1";
      res.json(await getUsage(req.params.provider, { force }));
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
    console.log(`workspace: ${workspaceDir()}`);
  });
  // Fire and forget — channels self-skip if not configured.
  void startAvailableChannels();
  return server;
}
