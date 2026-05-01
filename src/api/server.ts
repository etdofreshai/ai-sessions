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
import { VERSION, GIT } from "../version.js";
import * as hookStore from "../hooks/store.js";
import { dispatchHook } from "../hooks/dispatch.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  app.get("/", (_req, res) => {
    res.json({
      name: "ai-sessions",
      version: VERSION,
      git: GIT,
      yoloDefault: defaultYolo(),
      dataDir: dataDir(),
      workspaceDir: workspaceDir(),
      docs: "/openapi.json",
      endpoints: Object.keys(openapi.paths),
    });
  });

  app.get("/sha", (_req, res) => res.json(GIT));

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
      const { prompt, sessionId, aiSessionId, cwd, yolo, effort, attachments } =
        req.body ?? {};
      if (!prompt) return res.status(400).json({ error: "prompt required" });

      const handle = getProvider(String(req.params.provider)).run({
        prompt,
        sessionId,
        aiSessionId,
        cwd,
        yolo,
        effort,
        attachments,
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

      // SSE by default. Stop writing if the client disconnects so we don't
      // throw "write after end" once the socket is gone.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      let aborted = false;
      req.on("close", () => {
        aborted = true;
      });
      res.write(`event: meta\ndata: ${JSON.stringify(handle.meta)}\n\n`);
      for await (const ev of handle.events) {
        if (aborted) break;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      const final = await handle.done;
      if (!aborted) {
        res.write(`event: done\ndata: ${JSON.stringify(final)}\n\n`);
        res.end();
      }
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
      const { targetProvider, cwd } = req.body ?? {};
      const result = await forkAiSession({
        sourceId: req.params.id,
        targetProvider, // optional — omit for same-provider fork
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

  // Hook ingest from inner harnesses (Claude Code / Codex). The harness
  // POSTs the same JSON body it would normally pass to a hook command.
  // We persist it for inspection and return the standard "continue" hook
  // response so the harness keeps running. Acting on specific events
  // (block dangerous tool calls, forward to Telegram, capture bg-task
  // launches) layers on top of this in subsequent steps.
  function recordHook(harness: "claude" | "codex") {
    return (req: Request, res: Response) => {
      const payload = (req.body ?? {}) as Record<string, unknown>;
      try {
        const ev = hookStore.record({ harness, payload });
        console.error(
          `[hooks/${harness}] ${ev.eventName}` +
            (ev.toolName ? ` ${ev.toolName}` : "") +
            (ev.sessionId ? ` session=${ev.sessionId.slice(0, 8)}` : ""),
        );
      } catch (e: any) {
        console.error(`[hooks/${harness}] persist failed:`, e?.message ?? e);
      }
      // Drive in-flight UI / bg-task capture from the event. Persistence
      // failure shouldn't block dispatch and dispatch failure shouldn't
      // block the harness — both degrade open with a {"continue": true}.
      try {
        dispatchHook({ harness, payload });
      } catch (e: any) {
        console.error(`[hooks/${harness}] dispatch failed:`, e?.message ?? e);
      }
      res.json({ continue: true });
    };
  }

  app.post("/hooks/claude", recordHook("claude"));
  app.post("/hooks/codex", recordHook("codex"));

  // Long-running jobs — HTTP equivalents of the `ais jobs` CLI so an agent
  // running inside a container that doesn't have the CLI on PATH can drive
  // the queue via curl. Worker still lives inside `ais serve`.
  app.post("/jobs", async (req, res, next) => {
    try {
      const jobsStore = await import("../jobs/store.js");
      const { kind, payload, label, aiSessionId, chatId } = req.body ?? {};
      if (kind !== "bash") {
        return res.status(400).json({ error: "unknown kind (supported: bash)" });
      }
      if (!payload || typeof payload !== "object" || payload.kind !== "bash" || !payload.cmd) {
        return res.status(400).json({ error: "payload must be { kind: 'bash', cmd: <string>, cwd?, timeoutMs? }" });
      }
      const job = jobsStore.create({ kind, payload, label, aiSessionId, chatId });
      res.json(job);
    } catch (e) {
      next(e);
    }
  });

  app.get("/jobs", async (req, res, next) => {
    try {
      const jobsStore = await import("../jobs/store.js");
      const status = req.query.status as any;
      const aiSessionId = req.query.aiSessionId as string | undefined;
      const limit = Math.min(Number(req.query.limit ?? 100), 1000) || 100;
      res.json(jobsStore.list({ status, aiSessionId, limit }));
    } catch (e) {
      next(e);
    }
  });

  app.get("/jobs/:id", async (req, res, next) => {
    try {
      const jobsStore = await import("../jobs/store.js");
      const job = jobsStore.read(req.params.id);
      if (!job) return res.status(404).json({ error: "job not found" });
      res.json(job);
    } catch (e) {
      next(e);
    }
  });

  app.post("/jobs/:id/cancel", async (req, res, next) => {
    try {
      const jobsStore = await import("../jobs/store.js");
      const ok = jobsStore.cancel(req.params.id);
      if (!ok) return res.status(409).json({ error: "job not pending or running" });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Sub-agents — HTTP equivalents of `ais sub-agents`.
  app.post("/sub-agents", async (req, res, next) => {
    try {
      const { startSubAgent } = await import("../sub-agents/runner.js");
      const { parentAiSessionId, provider, prompt, cwd, label, steerChatId } = req.body ?? {};
      if (!parentAiSessionId) return res.status(400).json({ error: "parentAiSessionId required" });
      if (!provider) return res.status(400).json({ error: "provider required" });
      if (!prompt) return res.status(400).json({ error: "prompt required" });
      const sub = await startSubAgent({ parentAiSessionId, provider, prompt, cwd, label, steerChatId });
      res.json(sub);
    } catch (e: any) {
      // startSubAgent throws on policy violations (one-level-deep, unknown
      // provider, missing parent) — surface those as 400 not 500.
      const msg = e?.message ?? String(e);
      if (/^one-level-deep|^unknown provider|not found/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      next(e);
    }
  });

  app.get("/sub-agents", async (req, res, next) => {
    try {
      const subStore = await import("../sub-agents/store.js");
      const parentAiSessionId = req.query.parent as string | undefined;
      if (!parentAiSessionId) {
        return res.status(400).json({ error: "?parent=<ai-session-id> required" });
      }
      res.json(subStore.listByParent(parentAiSessionId));
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agents/:id", async (req, res, next) => {
    try {
      const subStore = await import("../sub-agents/store.js");
      const sub = subStore.read(req.params.id);
      if (!sub) return res.status(404).json({ error: "sub-agent not found" });
      res.json(sub);
    } catch (e) {
      next(e);
    }
  });

  app.get("/hooks", (req, res) => {
    const sessionId = (req.query.session_id as string | undefined) ?? undefined;
    const limit = Math.min(Number(req.query.limit ?? 200), 1000) || 200;
    res.json(
      sessionId
        ? hookStore.listForSession(sessionId, limit)
        : hookStore.listRecent(limit),
    );
  });

  app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
    // Map well-known error messages to client-facing status codes so callers
    // can distinguish "I asked for the wrong thing" from "the server broke".
    // Keep the list small and message-prefix-based — adding a typed error
    // hierarchy is overkill for this surface area today.
    const msg: string = err?.message ?? String(err);
    let status = 500;
    if (/^unknown provider\b/i.test(msg)) status = 400;
    else if (/^ai-session not found\b/i.test(msg)) status = 404;
    else if (/^cron not found\b/i.test(msg)) status = 404;
    else if (/^run not found\b/i.test(msg)) status = 404;
    else if (/\bsession not found\b/i.test(msg)) status = 404;
    else if (/\brequired\b/i.test(msg)) status = 400;
    res.status(status).json({ error: msg });
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
