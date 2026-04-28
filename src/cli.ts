#!/usr/bin/env node
import { Command } from "commander";
import { getProvider, listProviderNames, providers } from "./providers/index.js";
import { startServer } from "./api/server.js";
import { port as defaultPort } from "./config.js";
import { getLive, listRunIds, loadFromDisk } from "./runs/registry.js";
import * as aiStore from "./ai-sessions/store.js";
import { channels as channelRegistry, listChannelNames } from "./channels/index.js";
import * as cronStore from "./crons/store.js";
import { makeJob, nextFireAfter } from "./crons/scheduler.js";
import type { CronJob } from "./crons/types.js";

const program = new Command();
program
  .name("ai-sessions")
  .description("Thin CLI to call, manage, and view sessions across claude, codex, and opencode")
  .version("0.1.0");

program
  .command("providers")
  .description("List available providers")
  .action(async () => {
    for (const name of listProviderNames()) {
      const ok = await providers[name].isAvailable();
      console.log(`${ok ? "✓" : "·"} ${name}`);
    }
  });

program
  .command("list <provider>")
  .description("List sessions for a provider")
  .option("-l, --limit <n>", "limit results", (v) => parseInt(v, 10))
  .option("--json", "output JSON")
  .action(async (provider: string, opts: { limit?: number; json?: boolean }) => {
    let sessions = await getProvider(provider).listSessions();
    if (opts.limit) sessions = sessions.slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    for (const s of sessions) {
      console.log(`${s.updatedAt ?? "-"}  ${s.id}  ${s.cwd ?? ""}`);
    }
  });

program
  .command("view <provider> <id>")
  .description("View a session's transcript")
  .option("--json", "output JSON")
  .action(async (provider: string, id: string, opts: { json?: boolean }) => {
    const detail = await getProvider(provider).getSession(id);
    if (opts.json) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    console.log(`# ${provider}:${id}  (${detail.messageCount} messages)`);
    if (detail.cwd) console.log(`cwd: ${detail.cwd}`);
    console.log("");
    for (const m of detail.messages) {
      console.log(`--- ${m.role}${m.timestamp ? `  ${m.timestamp}` : ""} ---`);
      console.log(m.content);
      console.log("");
    }
  });

program
  .command("run <provider> <prompt>")
  .description("Start a new run. Pass --session to continue an existing session.")
  .option("-s, --session <id>", "continue an existing provider session")
  .option("-a, --as <ai-session-id>", "attribute this run to an AiSession id")
  .option("-c, --cwd <dir>", "working directory")
  .option("--no-yolo", "disable bypass-permissions / sandbox bypass")
  .option("--answer-only", "print just the final answer, suppressing intermediate stream")
  .action(
    async (
      provider: string,
      prompt: string,
      opts: {
        session?: string;
        as?: string;
        cwd?: string;
        yolo?: boolean;
        answerOnly?: boolean;
      }
    ) => {
      const handle = getProvider(provider).run({
        prompt,
        sessionId: opts.session,
        aiSessionId: opts.as,
        cwd: opts.cwd,
        yolo: opts.yolo,
      });
      if (!opts.answerOnly) {
        for await (const ev of handle.events) {
          if (ev.type === "text") process.stdout.write(ev.text);
          else if (ev.type === "tool_use")
            process.stderr.write(`\n[tool_use ${ev.name}]\n`);
          else if (ev.type === "error")
            process.stderr.write(`\n[error] ${ev.message}\n`);
        }
        process.stdout.write("\n");
      }
      const meta = await handle.done;
      if (opts.answerOnly) process.stdout.write((meta.output ?? "") + "\n");
      console.error(`run: ${meta.runId}  status: ${meta.status}`);
      if (meta.sessionId) console.error(`session: ${meta.sessionId}`);
      if (meta.aiSessionId) console.error(`ai-session: ${meta.aiSessionId}`);
    }
  );

const runs = program.command("runs").description("Manage runs");

runs
  .command("ls")
  .description("List recent run ids from dataDir/runs")
  .option("-l, --limit <n>", "limit results", (v) => parseInt(v, 10), 20)
  .action((opts: { limit: number }) => {
    for (const id of listRunIds(opts.limit)) {
      const meta = loadFromDisk(id);
      const live = getLive(id);
      const status = live ? "live" : meta?.status ?? "?";
      console.log(`${id}  ${status}  ${meta?.provider ?? ""}`);
    }
  });

runs
  .command("show <runId>")
  .description("Show a run's metadata + events")
  .action((runId: string) => {
    const meta = loadFromDisk(runId);
    if (!meta) {
      console.error(`run not found: ${runId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(meta, null, 2));
  });

runs
  .command("interrupt <runId>")
  .description("Interrupt a live run")
  .action(async (runId: string) => {
    const handle = getLive(runId);
    if (!handle) {
      console.error(`run not active in this process: ${runId}`);
      console.error("(use POST /providers/<p>/runs/<id>/interrupt against the server)");
      process.exit(1);
    }
    await handle.interrupt();
    console.log("interrupted");
  });

runs
  .command("steer <runId> <input>")
  .description("Inject a mid-run user message (Claude only today)")
  .action(async (runId: string, input: string) => {
    const handle = getLive(runId);
    if (!handle) {
      console.error(`run not active in this process: ${runId}`);
      process.exit(1);
    }
    if (!handle.steer) {
      console.error(`steer not supported by provider ${handle.meta.provider}`);
      process.exit(1);
    }
    await handle.steer(input);
    console.log("steered");
  });

const sessions = program.command("sessions").description("Manage AiSessions (provider-agnostic logical sessions)");

sessions
  .command("ls")
  .description("List AiSessions (most recently used first)")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const all = aiStore.list();
    if (opts.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    for (const s of all) {
      console.log(`${s.updatedAt}  ${s.id}  ${s.provider}  ${s.name ?? ""}`);
    }
  });

sessions
  .command("show <id>")
  .description("Show an AiSession")
  .action((id: string) => {
    const s = aiStore.read(id);
    if (!s) {
      console.error(`ai-session not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(s, null, 2));
  });

sessions
  .command("rename <id> <name>")
  .description("Set a new name on an AiSession")
  .action((id: string, name: string) => {
    const s = aiStore.read(id);
    if (!s) {
      console.error(`ai-session not found: ${id}`);
      process.exit(1);
    }
    s.name = name;
    aiStore.write(s);
    console.log(s.id);
  });

sessions
  .command("fork <id> <newProvider>")
  .description(
    "Create a new AiSession on a different provider, seeded from the source session"
  )
  .option("--destructive", "summarize instead of replaying full transcript")
  .option("-c, --cwd <dir>", "working directory for the seed run on the new provider")
  .action(
    async (
      id: string,
      newProvider: string,
      opts: { destructive?: boolean; cwd?: string }
    ) => {
      const { forkAiSession } = await import("./ai-sessions/fork.js");
      const result = await forkAiSession({
        sourceId: id,
        targetProvider: newProvider,
        destructive: opts.destructive,
        cwd: opts.cwd,
      });
      console.log(`forked: ${result.id}  provider: ${result.provider}  session: ${result.sessionId}`);
      console.error(
        `seed mode: ${result.seedMode}  (~${result.estimatedTokens} tokens estimated)`
      );
    }
  );

sessions
  .command("delete <id>")
  .description("Delete an AiSession (does not affect underlying provider sessions)")
  .action((id: string) => {
    const ok = aiStore.remove(id);
    if (!ok) {
      console.error(`ai-session not found: ${id}`);
      process.exit(1);
    }
    console.log("deleted");
  });

program
  .command("message <channel> <chatId> <message>")
  .description("Send an ad-hoc message via a channel (no session involved)")
  .option("--thread-id <n>", "telegram message_thread_id (forum topic)", (v) => parseInt(v, 10))
  .action(
    async (
      channel: string,
      chatId: string,
      message: string,
      opts: { threadId?: number }
    ) => {
      const ch = channelRegistry[channel];
      if (!ch) {
        console.error(`unknown channel: ${channel}`);
        process.exit(1);
      }
      if (!(await ch.isAvailable())) {
        console.error(`channel "${channel}" is not configured (check .env)`);
        process.exit(1);
      }
      const idNum = parseInt(chatId, 10);
      if (!Number.isFinite(idNum)) {
        console.error(`chatId must be numeric, got: ${chatId}`);
        process.exit(1);
      }
      await ch.send({ chatId: idNum, threadId: opts.threadId }, { text: message });
      console.log("sent");
    }
  );

program
  .command("channels")
  .description("List configured channels and their availability")
  .action(async () => {
    for (const name of listChannelNames()) {
      const ok = await channelRegistry[name].isAvailable();
      console.log(`${ok ? "[x]" : "[ ]"} ${name}`);
    }
  });

const crons = program.command("crons").description("Manage scheduled jobs");

crons
  .command("ls")
  .description("List cron jobs")
  .option("--json", "output JSON")
  .action((opts: { json?: boolean }) => {
    const all = cronStore.list();
    if (opts.json) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    for (const j of all) {
      const flag = j.enabled ? "on " : "off";
      console.log(`${flag}  ${j.name}  ${j.cron}  next=${j.nextRunAt}  ${j.target.kind}`);
    }
  });

crons
  .command("add-session <name> <cron> <aiSessionId> <prompt>")
  .description("Schedule a prompt to be sent to an AiSession")
  .option("-c, --cwd <dir>", "working directory override")
  .option("-z, --tz <tz>", "IANA timezone (e.g. America/Los_Angeles)")
  .option("-m, --missed <policy>", "skip|run_once|run_all", "skip")
  .action(
    (
      name: string,
      cron: string,
      aiSessionId: string,
      prompt: string,
      opts: { cwd?: string; tz?: string; missed?: CronJob["missedPolicy"] }
    ) => {
      const job = makeJob({
        name,
        cron,
        timezone: opts.tz,
        missedPolicy: opts.missed,
        target: { kind: "ai_session", aiSessionId, prompt, cwd: opts.cwd },
      });
      cronStore.write(job);
      console.log(`added: ${job.name}  next=${job.nextRunAt}`);
    }
  );

crons
  .command("add-command <name> <cron> <command> [args...]")
  .description("Schedule a shell command")
  .option("-c, --cwd <dir>", "working directory")
  .option("-z, --tz <tz>", "IANA timezone")
  .action(
    (
      name: string,
      cron: string,
      command: string,
      args: string[],
      opts: { cwd?: string; tz?: string }
    ) => {
      const job = makeJob({
        name,
        cron,
        timezone: opts.tz,
        target: { kind: "command", command, args, cwd: opts.cwd },
      });
      cronStore.write(job);
      console.log(`added: ${job.name}  next=${job.nextRunAt}`);
    }
  );

crons
  .command("rm <name>")
  .description("Remove a cron job")
  .action((name: string) => {
    const ok = cronStore.remove(name);
    if (!ok) {
      console.error(`cron not found: ${name}`);
      process.exit(1);
    }
    console.log("removed");
  });

crons
  .command("toggle <name>")
  .description("Enable or disable a cron job")
  .action((name: string) => {
    const j = cronStore.read(name);
    if (!j) {
      console.error(`cron not found: ${name}`);
      process.exit(1);
    }
    j.enabled = !j.enabled;
    if (j.enabled) {
      j.nextRunAt = nextFireAfter(j.cron, new Date(), j.timezone).toISOString();
    }
    cronStore.write(j);
    console.log(j.enabled ? "enabled" : "disabled");
  });

program
  .command("serve")
  .description("Start the local HTTP API")
  .option("-p, --port <port>", "port", (v) => parseInt(v, 10), defaultPort())
  .action(async (opts: { port: number }) => {
    const { startScheduler } = await import("./crons/scheduler.js");
    startScheduler();
    startServer(opts.port);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
