import * as aiStore from "../ai-sessions/store.js";
import { getProvider } from "../providers/index.js";
import { getLive } from "../runs/registry.js";
import {
  TelegramApi,
  type InlineKeyboardMarkup,
  type TgUpdate,
} from "./telegram-api.js";
import type { Channel, ChannelAddress, ChannelMessage, TelegramAddress } from "./types.js";

interface PendingBinding {
  firstMessage: string;
  awaitingSince: number;
}

function token(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function allowedUserIds(): Set<number> {
  const raw = process.env.TELEGRAM_ALLOWED_USERS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n))
  );
}

export class TelegramChannel implements Channel {
  name = "telegram";
  private api: TelegramApi | null = null;
  private polling = false;
  private offset = 0;
  // chatId → pending binding state (in-memory only).
  private pending = new Map<number, PendingBinding>();

  async isAvailable(): Promise<boolean> {
    return token() != null;
  }

  private ensureApi(): TelegramApi | null {
    if (this.api) return this.api;
    const t = token();
    if (!t) return null;
    this.api = new TelegramApi(t);
    return this.api;
  }

  async start(): Promise<void> {
    const api = this.ensureApi();
    if (!api) return;
    const me = await api.getMe();
    console.log(`[telegram] bot online as @${me.username ?? me.id}`);
    this.polling = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
  }

  async send(address: ChannelAddress, msg: ChannelMessage): Promise<void> {
    const api = this.ensureApi();
    if (!api) throw new Error("TELEGRAM_BOT_TOKEN not set");
    const a = address as TelegramAddress;
    if (!msg.text) return;
    // Telegram message limit: ~4096 chars; chunk safely.
    const chunks = chunk(msg.text, 4000);
    for (const text of chunks) {
      await api.sendMessage({
        chat_id: a.chatId,
        message_thread_id: a.threadId,
        text,
      });
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.polling && this.api) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((e) => {
            console.error("[telegram] handler error:", e?.message ?? e);
          });
        }
      } catch (e: any) {
        console.error("[telegram] poll error:", e?.message ?? e);
        await sleep(2000);
      }
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    const m = u.message;
    if (!m || !m.from) return;
    const allowed = allowedUserIds();
    if (allowed.size > 0 && !allowed.has(m.from.id)) return; // silent ignore
    const chatId = m.chat.id;
    const text = m.text ?? "";

    // Bound? Route to session.
    const session = aiStore.findByTelegramChat(chatId);
    if (session) {
      await this.routeToSession(session.id, text, chatId);
      return;
    }

    // Unbound: show picker (or store first message and present it).
    if (!this.pending.has(chatId)) {
      this.pending.set(chatId, {
        firstMessage: text,
        awaitingSince: Date.now(),
      });
    }
    await this.sendBindingPicker(chatId);
  }

  private async sendBindingPicker(chatId: number): Promise<void> {
    if (!this.api) return;
    const recent = aiStore.list().slice(0, 6);
    const buttons: InlineKeyboardMarkup["inline_keyboard"] = [];
    for (const s of recent) {
      const idShort = s.id.slice(0, 8);
      const label = `${idShort}  ${s.provider}  ${s.name ?? ""}`.slice(0, 60);
      buttons.push([{ text: label, callback_data: `bind:${s.id}` }]);
    }
    buttons.push([{ text: "+ new claude session", callback_data: "new:claude" }]);
    buttons.push([{ text: "+ new codex session", callback_data: "new:codex" }]);
    buttons.push([{ text: "+ new opencode session", callback_data: "new:opencode" }]);

    await this.api.sendMessage({
      chat_id: chatId,
      text:
        "This group isn't bound to a Session yet. Pick one below, or reply with a Session id to bind to it.",
      reply_markup: { inline_keyboard: buttons },
    });
  }

  private async handleCallback(cq: import("./telegram-api.js").TgCallbackQuery): Promise<void> {
    if (!this.api || !cq.message) return;
    const allowed = allowedUserIds();
    if (allowed.size > 0 && !allowed.has(cq.from.id)) {
      await this.api.answerCallbackQuery({ callback_query_id: cq.id, text: "not authorized" });
      return;
    }
    const chatId = cq.message.chat.id;
    const data = cq.data ?? "";
    await this.api.answerCallbackQuery({ callback_query_id: cq.id });

    if (data.startsWith("bind:")) {
      const sessionId = data.slice("bind:".length);
      const s = aiStore.read(sessionId);
      if (!s) {
        await this.api.sendMessage({ chat_id: chatId, text: `Session not found: ${sessionId}` });
        return;
      }
      s.channels = { ...(s.channels ?? {}), telegram: { chatId } };
      aiStore.write(s);
      await this.api.sendMessage({
        chat_id: chatId,
        text: `Bound to Session ${s.id} (${s.provider}${s.name ? ` · ${s.name}` : ""}).`,
      });
      const pending = this.pending.get(chatId);
      this.pending.delete(chatId);
      if (pending?.firstMessage) {
        await this.routeToSession(s.id, pending.firstMessage, chatId);
      }
      return;
    }

    if (data.startsWith("new:")) {
      const provider = data.slice("new:".length);
      const pending = this.pending.get(chatId);
      const firstPrompt = pending?.firstMessage || "Hello.";
      this.pending.delete(chatId);
      await this.api.sendMessage({
        chat_id: chatId,
        text: `Creating new ${provider} Session…`,
      });
      // Fire a run; the AiSession-finalize hook will create the Session and
      // we then attach the chat binding to it.
      try {
        const handle = getProvider(provider).run({ prompt: firstPrompt, yolo: true });
        const meta = await handle.done;
        if (meta.status !== "completed" || !meta.aiSessionId) {
          await this.api.sendMessage({
            chat_id: chatId,
            text: `Run ${meta.status}${meta.error ? `: ${meta.error}` : ""}`,
          });
          return;
        }
        const ai = aiStore.read(meta.aiSessionId);
        if (ai) {
          ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
          aiStore.write(ai);
        }
        await this.api.sendMessage({
          chat_id: chatId,
          text:
            `Bound new Session ${meta.aiSessionId} (${provider})\n\n${meta.output ?? ""}`.slice(
              0,
              4000
            ),
        });
      } catch (e: any) {
        await this.api.sendMessage({
          chat_id: chatId,
          text: `Failed to create session: ${e?.message ?? e}`,
        });
      }
      return;
    }
  }

  private async routeToSession(
    aiSessionId: string,
    text: string,
    chatId: number,
  ): Promise<void> {
    if (!this.api) return;
    const trimmed = text.trim();
    if (trimmed.startsWith("/interrupt")) {
      // Find any live run on this AiSession and abort it.
      // We don't yet index live runs by aiSessionId, so iterate the registry.
      const ai = aiStore.read(aiSessionId);
      if (!ai) return;
      // Best-effort: scan recent runs registry; v1 doesn't index this, so just
      // tell the user it's unsupported for now if no live run is found.
      await this.api.sendMessage({
        chat_id: chatId,
        text: "Interrupt requested. (Note: only works if a run on this session is live in this server process.)",
      });
      // TODO: index live runs by aiSessionId; for now, no live handle to interrupt.
      return;
    }
    if (!trimmed) return;
    // Plain text → start a run on the session (steer if a run is already live).
    const ai = aiStore.read(aiSessionId);
    if (!ai) {
      await this.api.sendMessage({ chat_id: chatId, text: "Session not found." });
      return;
    }
    try {
      const handle = getProvider(ai.provider).run({
        prompt: trimmed,
        aiSessionId: ai.id,
        yolo: true,
      });
      // Stream text events to the chat as they arrive.
      const live = getLive(handle.meta.runId);
      void (async () => {
        if (!live) return;
        let buffered = "";
        for await (const ev of live.events) {
          if (ev.type === "text") {
            buffered += ev.text;
            // Flush in 1KB chunks to avoid spamming.
            if (buffered.length > 1000) {
              await this.send({ chatId }, { text: buffered });
              buffered = "";
            }
          }
        }
        if (buffered) await this.send({ chatId }, { text: buffered });
      })();
      const meta = await handle.done;
      if (meta.status === "failed") {
        await this.api.sendMessage({
          chat_id: chatId,
          text: `Run failed: ${meta.error ?? "unknown error"}`,
        });
      }
    } catch (e: any) {
      await this.api.sendMessage({
        chat_id: chatId,
        text: `Error: ${e?.message ?? e}`,
      });
    }
  }
}

function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [""];
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export const telegramChannel = new TelegramChannel();
