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
import { ingestHook } from "../hooks/ingest.js";
import type { SubAgent } from "../sub-agents/types.js";
import type { CronTarget } from "../crons/types.js";

// Stall threshold for the running-but-silent heuristic. 5 minutes covers a
// long Bash + a reasoning step but flags genuinely stuck runs. Tunable via
// AI_SESSIONS_SUBAGENT_STALL_MS if a workload needs different bounds.
const SUBAGENT_STALL_MS = Number(process.env.AI_SESSIONS_SUBAGENT_STALL_MS ?? 5 * 60 * 1000);

function decorate(sub: SubAgent): SubAgent & {
  durationMs: number | null;
  idleMs: number | null;
  stalled: boolean;
} {
  const now = Date.now();
  const startMs = sub.startedAt ? Date.parse(sub.startedAt) : null;
  const endMs = sub.finishedAt ? Date.parse(sub.finishedAt) : null;
  const lastMs = sub.lastActivityAt ? Date.parse(sub.lastActivityAt) : startMs;
  const durationMs =
    startMs != null ? (endMs ?? now) - startMs : null;
  const idleMs =
    sub.status === "running" && lastMs != null ? now - lastMs : null;
  const stalled = sub.status === "running" && (idleMs ?? 0) > SUBAGENT_STALL_MS;
  return { ...sub, durationMs, idleMs, stalled };
}

function providerNames(): Set<string> {
  return new Set(listProviderNames());
}

function validateAiSessionId(value: unknown, field: string): { ok: true } | { ok: false; status: number; error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, status: 400, error: `${field} required` };
  }
  if (providerNames().has(value)) {
    return {
      ok: false,
      status: 400,
      error: `${field} must be an AiSession id, not provider name "${value}"`,
    };
  }
  if (!aiStore.read(value)) {
    return { ok: false, status: 400, error: `ai-session not found: ${value}` };
  }
  return { ok: true };
}

function validateCronTarget(target: any): { ok: true; target: CronTarget } | { ok: false; status: number; error: string } {
  if (!target?.kind) return { ok: false, status: 400, error: "target.kind required" };
  if (target.kind === "ai_session") {
    const id = validateAiSessionId(target.aiSessionId, "target.aiSessionId");
    if (!id.ok) return id;
    if (typeof target.prompt !== "string" || target.prompt.trim() === "") {
      return { ok: false, status: 400, error: "target.prompt required" };
    }
    return { ok: true, target };
  }
  if (target.kind === "provider_session") {
    if (typeof target.provider !== "string" || !providerNames().has(target.provider)) {
      return { ok: false, status: 400, error: `unknown provider: ${target.provider ?? ""}` };
    }
    if (typeof target.prompt !== "string" || target.prompt.trim() === "") {
      return { ok: false, status: 400, error: "target.prompt required" };
    }
    return { ok: true, target };
  }
  if (target.kind === "command") {
    if (typeof target.command !== "string" || target.command.trim() === "") {
      return { ok: false, status: 400, error: "target.command required" };
    }
    return { ok: true, target };
  }
  return { ok: false, status: 400, error: `unknown target.kind: ${target.kind}` };
}

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

  app.get("/current-session", (req, res) => {
    const aiSessionId =
      (req.query.aiSessionId as string | undefined) ??
      (req.header("x-ai-session-id") || undefined);
    if (aiSessionId) {
      const s = aiStore.read(aiSessionId);
      if (!s) return res.status(404).json({ error: `ai-session not found: ${aiSessionId}` });
      return res.json(s);
    }

    const provider =
      (req.query.provider as string | undefined) ??
      (req.header("x-provider") || undefined);
    const providerSessionId =
      (req.query.providerSessionId as string | undefined) ??
      (req.query.sessionId as string | undefined) ??
      (req.header("x-provider-session-id") || undefined);
    if (provider || providerSessionId) {
      if (!provider || !providerSessionId) {
        return res.status(400).json({ error: "provider and providerSessionId are both required" });
      }
      const s = aiStore.findByProviderSession(provider, providerSessionId);
      if (!s) {
        return res.status(404).json({
          error: `ai-session not found for provider=${provider} providerSessionId=${providerSessionId}`,
        });
      }
      return res.json(s);
    }

    res.status(400).json({
      error:
        "current session cannot be inferred from a bare HTTP request; pass aiSessionId or provider+providerSessionId",
      hint: "For Codex shells, use /current-session?provider=codex&providerSessionId=$CODEX_THREAD_ID.",
    });
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
    const valid = validateCronTarget(target);
    if (!valid.ok) return res.status(valid.status).json({ error: valid.error });
    const job = makeJob({ name, cron, target: valid.target, timezone, missedPolicy });
    cronStore.write(job);
    res.json(job);
  });

  app.patch("/crons/:name", (req, res) => {
    const j = cronStore.read(req.params.name);
    if (!j) return res.status(404).json({ error: "cron not found" });
    const { enabled, cron, target, timezone, missedPolicy } = req.body ?? {};
    if (typeof enabled === "boolean") j.enabled = enabled;
    if (typeof cron === "string") j.cron = cron;
    if (target) {
      const valid = validateCronTarget(target);
      if (!valid.ok) return res.status(valid.status).json({ error: valid.error });
      j.target = valid.target;
    }
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
        const ev = ingestHook({ harness, payload });
        console.error(
          `[hooks/${harness}] ${ev.eventName}` +
            (ev.toolName ? ` ${ev.toolName}` : "") +
            (ev.sessionId ? ` session=${ev.sessionId.slice(0, 8)}` : ""),
        );
      } catch (e: any) {
        console.error(`[hooks/${harness}] ingest failed:`, e?.message ?? e);
      }
      // Drive in-flight UI / bg-task capture from the event. Persistence
      // failure shouldn't block dispatch and dispatch failure shouldn't
      // block the harness — both degrade open with a {"continue": true}.
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
      const parent = validateAiSessionId(parentAiSessionId, "parentAiSessionId");
      if (!parent.ok) return res.status(parent.status).json({ error: parent.error });
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
      const parent = validateAiSessionId(parentAiSessionId, "parent");
      if (!parent.ok) return res.status(parent.status).json({ error: parent.error });
      res.json(subStore.listByParent(parentAiSessionId as string).map(decorate));
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agents/:id", async (req, res, next) => {
    try {
      const subStore = await import("../sub-agents/store.js");
      const sub = subStore.read(req.params.id);
      if (!sub) return res.status(404).json({ error: "sub-agent not found" });
      res.json(decorate(sub));
    } catch (e) {
      next(e);
    }
  });

  // Cancel a running/pending sub-agent: interrupt the child's run handle if
  // it's registered and mark the row cancelled. The runner's drain loop
  // observes the abort and finalizes the bubble normally.
  app.post("/sub-agents/:id/cancel", async (req, res, next) => {
    try {
      const subStore = await import("../sub-agents/store.js");
      const { cancelSubAgent } = await import("../sub-agents/runner.js");
      const sub = subStore.read(req.params.id);
      if (!sub) return res.status(404).json({ error: "sub-agent not found" });
      if (sub.status !== "running" && sub.status !== "pending") {
        return res.status(409).json({ error: `sub-agent already ${sub.status}` });
      }
      const ok = cancelSubAgent(sub.id);
      res.json({ ok, status: subStore.read(sub.id)?.status });
    } catch (e) {
      next(e);
    }
  });

  // ─── Sub-agent tasks ────────────────────────────────────────────────────
  // Supervisor-driven task queue. The supervisor LLM owns judgment (which
  // tasks to create, dependencies, retry policy, merge resolution); the
  // server owns deterministic mechanics (storage, dependency resolution,
  // stale detection, event log). See plan in commit message.
  app.post("/sub-agent-tasks", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const body = req.body ?? {};
      const ai = validateAiSessionId(body.aiSessionId, "aiSessionId");
      if (!ai.ok) return res.status(ai.status).json({ error: ai.error });
      if (typeof body.title !== "string" || !body.title.trim()) {
        return res.status(400).json({ error: "title required" });
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return res.status(400).json({ error: "prompt required" });
      }
      if (body.dependsOn !== undefined && !Array.isArray(body.dependsOn)) {
        return res.status(400).json({ error: "dependsOn must be an array of task ids" });
      }
      const task = taskStore.create({
        aiSessionId: body.aiSessionId,
        title: body.title,
        prompt: body.prompt,
        provider: body.provider,
        effort: body.effort,
        cwd: body.cwd,
        baseRef: body.baseRef,
        branchName: body.branchName,
        worktreePath: body.worktreePath,
        mergeStrategy: body.mergeStrategy,
        maxAttempts: body.maxAttempts,
        timeoutSeconds: body.timeoutSeconds,
        dependsOn: body.dependsOn,
      });
      res.json(task);
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agent-tasks", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const aiSessionId = req.query.aiSessionId as string | undefined;
      const status = req.query.status as string | undefined;
      const includeDeleted = req.query.includeDeleted === "1";
      if (aiSessionId) {
        const ai = validateAiSessionId(aiSessionId, "aiSessionId");
        if (!ai.ok) return res.status(ai.status).json({ error: ai.error });
      }
      res.json(taskStore.list({
        aiSessionId,
        status: status as never,
        includeDeleted,
      }));
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agent-tasks/runnable", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const aiSessionId = req.query.aiSessionId as string | undefined;
      const ai = validateAiSessionId(aiSessionId, "aiSessionId");
      if (!ai.ok) return res.status(ai.status).json({ error: ai.error });
      res.json(taskStore.listRunnable(aiSessionId as string));
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agent-tasks/:id", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      res.json(task);
    } catch (e) {
      next(e);
    }
  });

  app.patch("/sub-agent-tasks/:id", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const existing = taskStore.read(req.params.id);
      if (!existing) return res.status(404).json({ error: "task not found" });
      const updated = taskStore.update(req.params.id, req.body ?? {});
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  app.delete("/sub-agent-tasks/:id", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      taskStore.softDelete(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // Dispatch a task: launch a sub-agent for it. Picks provider from
  // request body, falling back to the task's stored provider field.
  app.post("/sub-agent-tasks/:id/dispatch", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const { startSubAgent } = await import("../sub-agents/runner.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      if (task.deletedAt) return res.status(409).json({ error: "task is deleted" });
      if (task.status !== "created" && task.status !== "merge_failed") {
        return res.status(409).json({ error: `task is ${task.status}; only created/merge_failed can be dispatched` });
      }
      const provider = (req.body?.provider as string | undefined) ?? task.provider;
      if (!provider) return res.status(400).json({ error: "provider required (not set on task and not in body)" });
      const deps = taskStore.listDependencies(task.id);
      for (const d of deps) {
        const dep = taskStore.read(d.dependsOnTaskId);
        if (!dep || dep.status !== "completed") {
          return res.status(409).json({
            error: `dependency ${d.dependsOnTaskId} is ${dep?.status ?? "missing"}; cannot dispatch`,
          });
        }
      }
      const sub = await startSubAgent({
        parentAiSessionId: task.aiSessionId,
        provider,
        prompt: task.prompt,
        cwd: task.worktreePath ?? task.cwd,
        label: task.title,
        taskId: task.id,
      });
      res.json({ task: taskStore.read(task.id), subAgent: sub });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/^one-level-deep|^unknown provider|not found/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      next(e);
    }
  });

  app.post("/sub-agent-tasks/:id/cancel", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const { cancelSubAgent } = await import("../sub-agents/runner.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        return res.status(409).json({ error: `task already ${task.status}` });
      }
      const reason = (req.body?.reason as string | undefined) ?? "cancelled by request";
      // If the task is running and tied to a sub-agent, interrupt that
      // sub-agent first; the runner's terminal-status path will mirror
      // the status onto the task. Otherwise just mark the row directly.
      if (task.status === "running" && task.subAgentId) {
        cancelSubAgent(task.subAgentId);
      }
      taskStore.cancel(task.id, reason);
      res.json(taskStore.read(task.id));
    } catch (e) {
      next(e);
    }
  });

  app.post("/sub-agent-tasks/:id/complete", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      taskStore.complete(req.params.id, req.body?.response);
      res.json(taskStore.read(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.post("/sub-agent-tasks/:id/fail", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      taskStore.fail(req.params.id, req.body?.response);
      res.json(taskStore.read(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.post("/sub-agent-tasks/:id/merge-failed", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      const response = req.body?.response;
      if (typeof response !== "string" || !response.trim()) {
        return res.status(400).json({ error: "response required (merge error details)" });
      }
      taskStore.markMergeFailed(req.params.id, response);
      res.json(taskStore.read(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.post("/sub-agent-tasks/:id/dependencies", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      const dependsOnTaskId = req.body?.dependsOnTaskId;
      if (typeof dependsOnTaskId !== "string" || !dependsOnTaskId) {
        return res.status(400).json({ error: "dependsOnTaskId required" });
      }
      const dep = taskStore.read(dependsOnTaskId);
      if (!dep) return res.status(400).json({ error: `dependsOnTaskId not found: ${dependsOnTaskId}` });
      const created = taskStore.addDependency(task.id, dependsOnTaskId);
      res.json(created);
    } catch (e: any) {
      if (/cannot depend on itself/.test(e?.message ?? "")) {
        return res.status(400).json({ error: e.message });
      }
      next(e);
    }
  });

  app.delete("/sub-agent-tasks/:id/dependencies/:depId", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const removed = taskStore.removeDependency(req.params.id, req.params.depId);
      if (!removed) return res.status(404).json({ error: "dependency not found" });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agent-tasks/:id/dependencies", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      res.json(taskStore.listDependencies(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get("/sub-agent-tasks/:id/events", async (req, res, next) => {
    try {
      const taskStore = await import("../sub-agent-tasks/store.js");
      const task = taskStore.read(req.params.id);
      if (!task) return res.status(404).json({ error: "task not found" });
      const limit = Math.min(Number(req.query.limit ?? 200), 1000) || 200;
      res.json(taskStore.listEvents(req.params.id, limit));
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
