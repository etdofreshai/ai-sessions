import * as aiStore from "../ai-sessions/store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { getLive } from "../runs/registry.js";
import { previewFromJsonl } from "../sessions/preview.js";
import {
  TelegramApi,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type TgCallbackQuery,
  type TgUpdate,
} from "./telegram-api.js";
import type { Channel, ChannelAddress, ChannelMessage, TelegramAddress } from "./types.js";

const PAGE_SIZE = 5;

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

// ---------- Keyboard builders ----------

function rootKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: "Existing session", callback_data: "nav:exist" }],
    [{ text: "+ New session", callback_data: "nav:new" }],
  ];
}

function existingProvidersKeyboard(): InlineKeyboardButton[][] {
  return [
    [{ text: "ai-sessions (saved)", callback_data: "list:ai-sessions:0" }],
    ...listProviderNames().map((p) => [
      { text: p, callback_data: `list:${p}:0` } as InlineKeyboardButton,
    ]),
    [{ text: "← back", callback_data: "nav:root" }],
  ];
}

function newProvidersKeyboard(): InlineKeyboardButton[][] {
  return [
    ...listProviderNames().map((p) => [
      { text: `+ new ${p} session`, callback_data: `new:${p}` } as InlineKeyboardButton,
    ]),
    [{ text: "← back", callback_data: "nav:root" }],
  ];
}

function pageNavRow(provider: string, page: number, hasPrev: boolean, hasNext: boolean): InlineKeyboardButton[] {
  const row: InlineKeyboardButton[] = [];
  if (hasPrev) row.push({ text: "← prev", callback_data: `list:${provider}:${page - 1}` });
  if (hasNext) row.push({ text: "next →", callback_data: `list:${provider}:${page + 1}` });
  return row;
}

// ---------- Channel ----------

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
    if (allowed.size > 0 && !allowed.has(m.from.id)) return;
    const chatId = m.chat.id;
    const text = m.text ?? "";

    const session = aiStore.findByTelegramChat(chatId);
    if (session) {
      await this.routeToSession(session.id, text, chatId);
      return;
    }

    if (!this.pending.has(chatId)) {
      this.pending.set(chatId, { firstMessage: text, awaitingSince: Date.now() });
    }
    await this.sendBindingPicker(chatId);
  }

  private async sendBindingPicker(chatId: number): Promise<void> {
    if (!this.api) return;
    await this.api.sendMessage({
      chat_id: chatId,
      text:
        "This group isn't bound to a Session yet. Pick an existing one or create a new one.",
      reply_markup: { inline_keyboard: rootKeyboard() },
    });
  }

  private async editTo(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboardButton[][],
  ): Promise<void> {
    if (!this.api) return;
    await this.api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  // List a paginated set of choices for the given provider scope.
  // For provider="ai-sessions" we list saved AiSessions (bind:<id>).
  // For other providers we list provider-native sessions (attach:<provider>:<sessionId>).
  private async buildListPage(
    provider: string,
    page: number,
  ): Promise<{ rows: InlineKeyboardButton[][]; hasPrev: boolean; hasNext: boolean; header: string }> {
    let header: string;
    let entries: Array<{ id: string; label: string; callback: string }> = [];

    if (provider === "ai-sessions") {
      header = "Saved AiSessions:";
      entries = aiStore.list().map((s) => ({
        id: s.id,
        label:
          `${s.id.slice(0, 8)} · ${s.provider} · ${s.name ?? "(unnamed)"}`.slice(0, 60),
        callback: `bind:${s.id}`,
      }));
    } else {
      header = `${provider} sessions:`;
      const sessions = await getProvider(provider).listSessions();
      entries = sessions.map((s) => ({
        id: s.id,
        // Path needed for preview enrichment below.
        label: `${s.id.slice(0, 8)} · ${s.cwd ?? ""}`.slice(0, 60),
        callback: `attach:${provider}:${s.id}`,
        path: s.path,
      })) as Array<{ id: string; label: string; callback: string; path?: string }>;
    }

    const start = page * PAGE_SIZE;
    const slice = entries.slice(start, start + PAGE_SIZE);
    // Enrich the visible slice with a first-message preview when the underlying
    // file is JSONL (cheap single-line read). Falls back to the original label.
    await Promise.all(
      slice.map(async (e: any) => {
        if (!e.path || !e.path.endsWith(".jsonl")) return;
        const preview = await previewFromJsonl(e.path);
        if (preview) {
          e.label = `${e.id.slice(0, 8)} · ${preview}`.slice(0, 60);
        }
      })
    );
    const rows = slice.map((e) => [{ text: e.label, callback_data: e.callback }]);
    return {
      rows,
      hasPrev: page > 0,
      hasNext: start + PAGE_SIZE < entries.length,
      header: `${header} (${entries.length} total, page ${page + 1})`,
    };
  }

  private async handleCallback(cq: TgCallbackQuery): Promise<void> {
    if (!this.api || !cq.message) return;
    const allowed = allowedUserIds();
    if (allowed.size > 0 && !allowed.has(cq.from.id)) {
      await this.api.answerCallbackQuery({ callback_query_id: cq.id, text: "not authorized" });
      return;
    }
    const chatId = cq.message.chat.id;
    const messageId = cq.message.message_id;
    const data = cq.data ?? "";
    await this.api.answerCallbackQuery({ callback_query_id: cq.id });

    if (data === "nav:root") {
      await this.editTo(
        chatId,
        messageId,
        "Pick an existing Session or create a new one.",
        rootKeyboard(),
      );
      return;
    }
    if (data === "nav:exist") {
      await this.editTo(
        chatId,
        messageId,
        "Pick a provider to browse existing sessions:",
        existingProvidersKeyboard(),
      );
      return;
    }
    if (data === "nav:new") {
      await this.editTo(
        chatId,
        messageId,
        "Pick a provider for the new Session:",
        newProvidersKeyboard(),
      );
      return;
    }

    if (data.startsWith("list:")) {
      const [, provider, pageStr] = data.split(":");
      const page = Math.max(0, parseInt(pageStr ?? "0", 10) || 0);
      const { rows, hasPrev, hasNext, header } = await this.buildListPage(provider, page);
      const navRow = pageNavRow(provider, page, hasPrev, hasNext);
      const keyboard: InlineKeyboardButton[][] = [...rows];
      if (navRow.length) keyboard.push(navRow);
      keyboard.push([{ text: "← back", callback_data: "nav:exist" }]);
      await this.editTo(chatId, messageId, header, keyboard);
      return;
    }

    if (data.startsWith("bind:")) {
      const aiId = data.slice("bind:".length);
      await this.bindAiSession(chatId, messageId, aiId);
      return;
    }

    if (data.startsWith("attach:")) {
      // attach:<provider>:<providerSessionId>
      const rest = data.slice("attach:".length);
      const sep = rest.indexOf(":");
      if (sep < 0) return;
      const provider = rest.slice(0, sep);
      const providerSessionId = rest.slice(sep + 1);
      await this.attachProviderSession(chatId, messageId, provider, providerSessionId);
      return;
    }

    if (data.startsWith("new:")) {
      const provider = data.slice("new:".length);
      await this.createNewSession(chatId, messageId, provider);
      return;
    }
  }

  private async bindAiSession(chatId: number, messageId: number, aiId: string): Promise<void> {
    const s = aiStore.read(aiId);
    if (!s) {
      await this.editTo(chatId, messageId, `Session not found: ${aiId}`);
      return;
    }
    s.channels = { ...(s.channels ?? {}), telegram: { chatId } };
    aiStore.write(s);
    await this.editTo(
      chatId,
      messageId,
      `Bound to Session ${s.id} (${s.provider}${s.name ? ` · ${s.name}` : ""}).`,
    );
    const pending = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (pending?.firstMessage) {
      await this.routeToSession(s.id, pending.firstMessage, chatId);
    }
  }

  // Wrap an existing provider-native session in a new AiSession and bind chat.
  private async attachProviderSession(
    chatId: number,
    messageId: number,
    provider: string,
    providerSessionId: string,
  ): Promise<void> {
    let ai = aiStore.findByProviderSession(provider, providerSessionId);
    if (!ai) {
      ai = aiStore.create({ provider, sessionId: providerSessionId });
    }
    ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
    aiStore.write(ai);
    await this.editTo(
      chatId,
      messageId,
      `Bound to Session ${ai.id} (${provider} · ${providerSessionId.slice(0, 8)}).`,
    );
    const pending = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (pending?.firstMessage) {
      await this.routeToSession(ai.id, pending.firstMessage, chatId);
    }
  }

  // Create an empty AiSession on the given provider and bind chat. The first
  // message routed to the session will populate `sessionId` via the normal
  // provider.run() → finalize flow.
  private async createNewSession(chatId: number, messageId: number, provider: string): Promise<void> {
    if (!listProviderNames().includes(provider)) {
      await this.editTo(chatId, messageId, `Unknown provider: ${provider}`);
      return;
    }
    const ai = aiStore.create({ provider });
    ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
    aiStore.write(ai);
    await this.editTo(
      chatId,
      messageId,
      `New Session ${ai.id} (${provider}). Send a message to start.`,
    );
    const pending = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (pending?.firstMessage) {
      await this.routeToSession(ai.id, pending.firstMessage, chatId);
    }
  }

  // Keeps the "typing…" indicator visible while a run is in flight. Telegram
  // auto-clears the action after ~5s, so we refresh every 4s.
  private startTyping(chatId: number): () => void {
    if (!this.api) return () => {};
    const api = this.api;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      api.sendChatAction({ chat_id: chatId, action: "typing" }).catch(() => {});
    };
    tick();
    const interval = setInterval(tick, 4000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  private async routeToSession(
    aiSessionId: string,
    text: string,
    chatId: number,
  ): Promise<void> {
    if (!this.api) return;
    const trimmed = text.trim();
    if (trimmed.startsWith("/interrupt")) {
      await this.api.sendMessage({
        chat_id: chatId,
        text: "Interrupt requested. (Note: only works if a run on this session is live in this server process.)",
      });
      return;
    }
    if (!trimmed) return;
    const ai = aiStore.read(aiSessionId);
    if (!ai) {
      await this.api.sendMessage({ chat_id: chatId, text: "Session not found." });
      return;
    }
    const stopTyping = this.startTyping(chatId);
    const status = await this.openStatusBlock(chatId);
    try {
      const handle = getProvider(ai.provider).run({
        prompt: trimmed,
        aiSessionId: ai.id,
        yolo: true,
      });
      const live = getLive(handle.meta.runId);
      const watcher = (async () => {
        if (!live) return;
        for await (const ev of live.events) {
          if (ev.type === "tool_use") {
            const inputStr = formatToolInput(ev.input);
            status.push(`🔧 ${ev.name}${inputStr ? `: ${inputStr}` : ""}`);
          } else if (ev.type === "tool_result") {
            // Mark previous tool line as complete; light touch.
            status.markLastDone();
          } else if (ev.type === "error") {
            status.push(`❌ ${ev.message}`);
          }
        }
      })();

      const meta = await handle.done;
      await watcher; // make sure all events are reflected
      const finalText =
        meta.output?.trim() ||
        (meta.error ? `Run failed: ${meta.error}` : "(no output)");
      await status.finalize(finalText);
    } catch (e: any) {
      await status.finalize(`Error: ${e?.message ?? e}`);
    } finally {
      stopTyping();
    }
  }

  // Creates an initial "thinking…" message and returns a controller that
  // batches edits (≥1.5s apart) and supports a final replacement.
  private async openStatusBlock(chatId: number): Promise<{
    push: (line: string) => void;
    markLastDone: () => void;
    finalize: (text: string) => Promise<void>;
  }> {
    const api = this.api!;
    let messageId: number | null = null;
    const lines: string[] = ["🤔 thinking…"];
    let lastEditAt = 0;
    let pending: NodeJS.Timeout | null = null;
    const MIN_INTERVAL = 1500;
    const MAX_LINES = 12;

    const render = () => lines.join("\n").slice(0, 4000) || "🤔 thinking…";

    try {
      const m = await api.sendMessage({ chat_id: chatId, text: render() });
      messageId = m.message_id;
      lastEditAt = Date.now();
    } catch {
      /* ignore — best-effort */
    }

    const editNow = async (): Promise<void> => {
      if (messageId == null) return;
      try {
        await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: render(),
        });
        lastEditAt = Date.now();
      } catch {
        /* "message is not modified" / rate limit — ignore */
      }
    };

    const schedule = (): void => {
      if (pending) return;
      const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastEditAt));
      pending = setTimeout(() => {
        pending = null;
        void editNow();
      }, wait);
    };

    return {
      push: (line: string) => {
        // Drop the initial placeholder once real activity arrives.
        if (lines.length === 1 && lines[0] === "🤔 thinking…") lines.length = 0;
        lines.push(line);
        if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
        schedule();
      },
      markLastDone: () => {
        const last = lines[lines.length - 1];
        if (last && last.startsWith("🔧 ")) {
          lines[lines.length - 1] = last.replace(/^🔧/, "✓");
        }
        schedule();
      },
      finalize: async (text: string) => {
        if (pending) {
          clearTimeout(pending);
          pending = null;
        }
        if (messageId == null) {
          await this.send({ chatId }, { text });
          return;
        }
        const head = text.slice(0, 4096);
        try {
          await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: head,
          });
        } catch {
          /* ignore */
        }
        if (text.length > 4096) {
          await this.send({ chatId }, { text: text.slice(4096) });
        }
      },
    };
  }
}

function formatToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.split(/\r?\n/)[0].slice(0, 60);
  try {
    const s = JSON.stringify(input);
    return s.length > 60 ? s.slice(0, 57) + "..." : s;
  } catch {
    return "";
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
