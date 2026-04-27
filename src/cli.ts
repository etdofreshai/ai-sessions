#!/usr/bin/env node
import { Command } from "commander";
import { getProvider, listProviderNames, providers } from "./providers/index.js";
import { startServer } from "./api/server.js";
import { port as defaultPort } from "./config.js";

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
  .description("Run a new prompt in a fresh session")
  .option("-c, --cwd <dir>", "working directory")
  .option("--no-yolo", "disable bypass-permissions / sandbox bypass")
  .action(async (provider: string, prompt: string, opts: { cwd?: string; yolo?: boolean }) => {
    const result = await getProvider(provider).run({
      prompt,
      cwd: opts.cwd,
      yolo: opts.yolo,
      onChunk: (c) => process.stdout.write(c),
    });
    process.stdout.write("\n");
    if (result.sessionId) console.error(`session: ${result.sessionId}`);
  });

program
  .command("resume <provider> <id> <prompt>")
  .description("Resume an existing session with a new prompt")
  .option("-c, --cwd <dir>", "working directory")
  .option("--no-yolo", "disable bypass-permissions / sandbox bypass")
  .action(async (provider: string, id: string, prompt: string, opts: { cwd?: string; yolo?: boolean }) => {
    const result = await getProvider(provider).run({
      prompt,
      sessionId: id,
      cwd: opts.cwd,
      yolo: opts.yolo,
      onChunk: (c) => process.stdout.write(c),
    });
    process.stdout.write("\n");
    if (result.sessionId) console.error(`session: ${result.sessionId}`);
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
