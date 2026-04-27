import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter } from "node:path";
import { existsSync } from "node:fs";

// Minimal NDJSON JSON-RPC 2.0 client for the `codex app-server` stdio transport.
// Each line on stdout is one JSON message: a response (has `id`) or a
// server-initiated notification (has `method`, no `id`).

export type RpcParams = Record<string, unknown> | undefined;
export type NotificationHandler = (params: any) => void;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notifyHandlers = new Map<string, Set<NotificationHandler>>();
  private closed = false;
  private exitPromise: Promise<number | null>;

  static resolveCommand(): string[] {
    const override = process.env.CODEX_BIN;
    if (override) return [override, "app-server"];
    const candidates =
      process.platform === "win32"
        ? ["codex.cmd", "codex.exe", "codex"]
        : ["codex"];
    for (const name of candidates) {
      const found = whichSync(name);
      if (found) return [found, "app-server"];
    }
    return ["codex", "app-server"];
  }

  constructor(opts: { command?: string[]; cwd?: string } = {}) {
    const cmd = opts.command ?? CodexAppServer.resolveCommand();
    // On Windows, .cmd shims require shell:true to spawn correctly.
    const useShell =
      process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd[0]);
    this.child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    let stderrBuf = "";
    this.child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        this.closed = true;
        for (const p of this.pending.values()) {
          p.reject(
            new Error(
              `codex app-server exited (code=${code}) with pending request${
                stderrBuf ? `; stderr: ${stderrBuf.slice(-500)}` : ""
              }`
            )
          );
        }
        this.pending.clear();
        resolve(code);
      });
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON output
    }
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(
            typeof msg.error === "string"
              ? msg.error
              : msg.error.message || JSON.stringify(msg.error)
          )
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      const handlers = this.notifyHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(msg.params);
          } catch {
            /* swallow handler errors */
          }
        }
      }
      // Wildcard handlers receive `{method, params}`.
      const wild = this.notifyHandlers.get("*");
      if (wild) {
        for (const h of wild) {
          try {
            h({ method: msg.method, params: msg.params });
          } catch {
            /* swallow */
          }
        }
      }
    }
  }

  request<T = any>(method: string, params?: RpcParams): Promise<T> {
    if (this.closed) return Promise.reject(new Error("client closed"));
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  notify(method: string, params?: RpcParams): void {
    if (this.closed) return;
    const payload = { jsonrpc: "2.0", method, params };
    try {
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    } catch {
      /* ignore */
    }
  }

  on(method: string, handler: NotificationHandler): () => void {
    let set = this.notifyHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notifyHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    // Give it a moment to exit cleanly, then kill.
    const timeout = setTimeout(() => {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }, 2000);
    await this.exitPromise;
    clearTimeout(timeout);
  }
}

function whichSync(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const p = `${dir}\\${name}`.replace(/\\/g, process.platform === "win32" ? "\\" : "/");
    const candidate = process.platform === "win32" ? p : `${dir}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
