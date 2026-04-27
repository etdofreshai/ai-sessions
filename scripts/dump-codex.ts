// Debug: spawn codex app-server, run a turn, log every incoming message.
import { CodexAppServer } from "../src/providers/codex-rpc.js";

async function main() {
  const c = new CodexAppServer({});
  c.on("*", (e) => {
    console.log("notif:", JSON.stringify(e));
  });
  await c.request("initialize", {
    clientInfo: { name: "ais-dbg", title: "ais-dbg", version: "0" },
  });
  const t: any = await c.request("thread/start", {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
  console.log("thread:", t.thread.id);
  const turn: any = await c.request("turn/start", {
    threadId: t.thread.id,
    input: [{ type: "text", text: "reply with: ok" }],
  });
  console.log("turn-start result:", JSON.stringify(turn));
  await new Promise((r) => setTimeout(r, 8000));
  await c.close();
}
main().catch((e) => {
  console.error("ERR:", e);
  process.exit(1);
});
