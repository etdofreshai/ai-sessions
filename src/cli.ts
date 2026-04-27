#!/usr/bin/env node
import { Command } from "commander";
import { getProvider, listProviderNames, providers } from "./providers/index.js";
import { startServer } from "./api/server.js";
import { port as defaultPort } from "./config.js";
import { getLive, listRunIds, loadFromDisk } from "./runs/registry.js";

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
  .option("-s, --session <id>", "continue an existing session")
  .option("-c, --cwd <dir>", "working directory")
  .option("--no-yolo", "disable bypass-permissions / sandbox bypass")
  .option("--answer-only", "print just the final answer, suppressing intermediate stream")
  .action(
    async (
      provider: string,
      prompt: string,
      opts: { session?: string; cwd?: string; yolo?: boolean; answerOnly?: boolean }
    ) => {
      const handle = getProvider(provider).run({
        prompt,
        sessionId: opts.session,
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

program
  .command("serve")
  .description("Start the local HTTP API")
  .option("-p, --port <port>", "port", (v) => parseInt(v, 10), defaultPort())
  .action((opts: { port: number }) => {
    startServer(opts.port);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
