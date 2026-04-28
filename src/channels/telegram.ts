import * as aiStore from "../ai-sessions/store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { getLive } from "../runs/registry.js";
import { workspaceDir } from "../config.js";
import { listSkills } from "../skills/catalog.js";
import { previewFromJsonl, shortenPath } from "../sessions/preview.js";
import { markdownToTelegramHtml } from "./telegram-format.js";
import { downloadTelegramFile } from "./telegram-download.js";
import { transcribe } from "./stt.js";
import type { Attachment } from "../providers/types.js";
import {
  TelegramApi,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type TgCallbackQuery,
  type TgUpdate,
} from "./telegram-api.js";
import type { Channel, ChannelAddress, ChannelMessage, TelegramAddress } from "./types.js";

const PAGE_SIZE = 5;

const SLASH_COMMANDS = [
  { command: "help", description: "List available commands" },
  { command: "status", description: "Show this chat's bound session" },
  { command: "bind", description: "(Re)bind this chat to a Session" },
  { command: "cwd", description: "Show or set the bound session's cwd" },
  { command: "rename", description: "Rename the bound session (no arg = auto-summarize)" },
  { command: "skills", description: "List enabled skills in the workspace" },
  { command: "interrupt", description: "Interrupt the current run (best-effort)" },
];

interface PendingBinding {
  firstMessage: string;
  attachments?: Attachment[];
  awaitingSince: number;
}

interface MediaGroupBuffer {
  chatId: number;
  caption: string;
  attachments: Attachment[];
  flushTimer: NodeJS.Timeout | null;
}

const MEDIA_GROUP_FLUSH_MS = 1200;

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
  // media_group_id → buffered photos that arrived in the same album.
  private mediaGroups = new Map<string, MediaGroupBuffer>();

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
    // Advertise slash commands in the bot menu. Best-effort — don't block start.
    api
      .setMyCommands({ commands: SLASH_COMMANDS })
      .catch((e: any) => console.error("[telegram] setMyCommands failed:", e?.message ?? e));
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
    // Convert each chunk independently so split boundaries can't break tags.
    const plainChunks = chunk(msg.text, 4000);
    for (const plain of plainChunks) {
      const html = markdownToTelegramHtml(plain);
      try {
        await api.sendMessage({
          chat_id: a.chatId,
          message_thread_id: a.threadId,
          text: html,
          parse_mode: "HTML",
        });
      } catch {
        // Rare: malformed HTML after conversion. Fall back to plain.
        await api.sendMessage({
          chat_id: a.chatId,
          message_thread_id: a.threadId,
          text: plain,
        });
      }
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

    // Group → supergroup migration: rebind any AiSession that was pointing at
    // the old chat id (this message arrives in the *old* chat with the new id).
    if (m.migrate_to_chat_id) {
      this.handleMigration(chatId, m.migrate_to_chat_id);
      return;
    }
    // Mirror message in the new supergroup; same handling either direction.
    if (m.migrate_from_chat_id) {
      this.handleMigration(m.migrate_from_chat_id, chatId);
      // Don't return — the new-chat message may also carry text we want to handle.
    }

    // Slash commands take priority over everything else.
    const text = m.text ?? "";
    if (text.startsWith("/")) {
      const handled = await this.handleSlashCommand(text, chatId);
      if (handled) return;
    }

    // Photo album (media group) — buffer and flush after a short timeout.
    if (m.photo && m.photo.length && m.media_group_id) {
      await this.bufferMediaGroup(m, chatId);
      return;
    }

    // Single photo (no album).
    if (m.photo && m.photo.length) {
      const att = await this.downloadPhoto(m, chatId);
      const text = m.caption ?? "";
      await this.dispatch(chatId, text, att ? [att] : []);
      return;
    }

    // Voice / audio — transcribe via STT, treat as text.
    if (m.voice || m.audio) {
      await this.dispatchAudio(m, chatId);
      return;
    }

    // Document / video / video_note — path reference attachment.
    if (m.document || m.video || m.video_note) {
      const cap = m.caption ?? "";
      const att = await this.downloadDocument(m, chatId);
      await this.dispatch(chatId, cap, att ? [att] : []);
      return;
    }

    // Plain text (already checked for slash commands above).
    await this.dispatch(chatId, text, []);
  }

  private async dispatch(
    chatId: number,
    text: string,
    attachments: Attachment[]
  ): Promise<void> {
    const session = aiStore.findByTelegramChat(chatId);
    if (session) {
      await this.routeToSession(session.id, text, chatId, attachments);
      return;
    }
    if (!this.pending.has(chatId)) {
      this.pending.set(chatId, {
        firstMessage: text,
        attachments,
        awaitingSince: Date.now(),
      });
    } else {
      // Subsequent unbound messages append to pending content.
      const p = this.pending.get(chatId)!;
      if (text) p.firstMessage = p.firstMessage ? `${p.firstMessage}\n${text}` : text;
      if (attachments.length) p.attachments = [...(p.attachments ?? []), ...attachments];
    }
    await this.sendBindingPicker(chatId);
  }

  private async dispatchAudio(m: any, chatId: number): Promise<void> {
    const api = this.ensureApi();
    if (!api) return;
    const file = m.voice ?? m.audio;
    const aiSessionId = aiStore.findByTelegramChat(chatId)?.id;
    let transcribed = "";
    let downloaded;
    try {
      downloaded = await downloadTelegramFile(api, file.file_id, {
        aiSessionId,
        preferredName: file.file_name ?? `voice-${file.file_id.slice(-8)}`,
        mimeType: file.mime_type,
      });
      transcribed = await transcribe(downloaded.path, { mimeType: file.mime_type });
    } catch (e: any) {
      await api.sendMessage({
        chat_id: chatId,
        text: `Could not transcribe audio: ${e?.message ?? e}`,
      });
      return;
    }
    if (!transcribed) {
      await api.sendMessage({ chat_id: chatId, text: "(audio transcribed to empty text)" });
      return;
    }
    await api.sendMessage({ chat_id: chatId, text: `🎤 ${transcribed}` });
    await this.dispatch(chatId, transcribed, []);
  }

  private async downloadPhoto(m: any, chatId: number): Promise<Attachment | null> {
    const api = this.ensureApi();
    if (!api || !m.photo?.length) return null;
    const aiSessionId = aiStore.findByTelegramChat(chatId)?.id;
    // Telegram returns multiple sizes; the largest is the last entry.
    const largest = m.photo[m.photo.length - 1];
    try {
      const dl = await downloadTelegramFile(api, largest.file_id, {
        aiSessionId,
        preferredName: `photo-${largest.file_unique_id}.jpg`,
        mimeType: "image/jpeg",
      });
      return { kind: "image", path: dl.path, filename: dl.filename, mimeType: dl.mimeType };
    } catch {
      return null;
    }
  }

  private async downloadDocument(m: any, chatId: number): Promise<Attachment | null> {
    const api = this.ensureApi();
    if (!api) return null;
    const file = m.document ?? m.video ?? m.video_note;
    if (!file) return null;
    const aiSessionId = aiStore.findByTelegramChat(chatId)?.id;
    try {
      const dl = await downloadTelegramFile(api, file.file_id, {
        aiSessionId,
        preferredName: file.file_name,
        mimeType: file.mime_type,
      });
      const isImage = (file.mime_type ?? "").startsWith("image/");
      return {
        kind: isImage ? "image" : "document",
        path: dl.path,
        filename: dl.filename,
        mimeType: dl.mimeType ?? file.mime_type,
      };
    } catch {
      return null;
    }
  }

  // Buffer Telegram album messages (same media_group_id) and flush as a
  // single dispatch after a quiet period.
  private async bufferMediaGroup(m: any, chatId: number): Promise<void> {
    const groupId = m.media_group_id as string;
    let buf = this.mediaGroups.get(groupId);
    if (!buf) {
      buf = { chatId, caption: "", attachments: [], flushTimer: null };
      this.mediaGroups.set(groupId, buf);
    }
    if (m.caption && !buf.caption) buf.caption = m.caption;
    const att = await this.downloadPhoto(m, chatId);
    if (att) buf.attachments.push(att);
    if (buf.flushTimer) clearTimeout(buf.flushTimer);
    buf.flushTimer = setTimeout(() => {
      this.mediaGroups.delete(groupId);
      void this.dispatch(buf!.chatId, buf!.caption, buf!.attachments);
    }, MEDIA_GROUP_FLUSH_MS);
  }

  // When a group migrates to a supergroup, Telegram replaces the chat id.
  // Rewrite any AiSession that pointed at the old id to use the new one.
  private handleMigration(oldChatId: number, newChatId: number): void {
    const ai = aiStore.findByTelegramChat(oldChatId);
    if (!ai) return;
    ai.channels = { ...(ai.channels ?? {}), telegram: { chatId: newChatId } };
    aiStore.write(ai);
    console.log(
      `[telegram] migrated session ${ai.id.slice(0, 8)} chat ${oldChatId} → ${newChatId}`
    );
    // Confirm in the new chat so the user knows the binding survived.
    const api = this.ensureApi();
    api
      ?.sendMessage({
        chat_id: newChatId,
        text: `Group migrated to supergroup; binding updated for Session ${ai.id.slice(0, 8)}.`,
      })
      .catch(() => {});
  }

  // Returns true if a slash command was recognized and handled. Falls through
  // to default routing otherwise (e.g. "/path/to/file" sent as plain text).
  private async handleSlashCommand(text: string, chatId: number): Promise<boolean> {
    const api = this.ensureApi();
    if (!api) return false;
    // Strip optional @botname suffix Telegram appends in groups.
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.split("@")[0].toLowerCase();
    const arg = rest.join(" ");

    if (cmd === "/help") {
      const lines = SLASH_COMMANDS.map((c) => `/${c.command} — ${c.description}`);
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
      return true;
    }

    if (cmd === "/status") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Not bound. Send /bind to pick a Session.",
        });
        return true;
      }
      const lines = [
        `Session: ${ai.id}`,
        `Name: ${ai.name ?? "(unnamed)"}`,
        `Provider: ${ai.provider}`,
        `Provider session: ${ai.sessionId ?? "(not yet started)"}`,
        `cwd: ${ai.cwd ?? "(unset)"}`,
      ];
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
      return true;
    }

    if (cmd === "/bind") {
      // Force re-binding by clearing the existing telegram link, then show picker.
      const ai = aiStore.findByTelegramChat(chatId);
      if (ai) {
        ai.channels = { ...(ai.channels ?? {}) };
        delete ai.channels.telegram;
        aiStore.write(ai);
      }
      this.pending.delete(chatId);
      await this.sendBindingPicker(chatId);
      return true;
    }

    if (cmd === "/cwd") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      if (!arg) {
        await api.sendMessage({
          chat_id: chatId,
          text: `cwd: ${ai.cwd ?? "(unset)"}`,
        });
        return true;
      }
      ai.cwd = arg;
      aiStore.write(ai);
      await api.sendMessage({ chat_id: chatId, text: `cwd set to: ${arg}` });
      return true;
    }

    if (cmd === "/rename") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      if (arg) {
        ai.name = arg;
        aiStore.write(ai);
        await api.sendMessage({ chat_id: chatId, text: `Renamed to: ${arg}` });
        return true;
      }
      // No arg → ask the default agent to summarize the current transcript.
      if (!ai.sessionId) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Can't auto-rename: no provider session yet (send a message first).",
        });
        return true;
      }
      const stopTyping = this.startTyping(chatId);
      try {
        const detail = await getProvider(ai.provider).getSession(ai.sessionId);
        const transcript = detail.messages
          .map((m) => `[${m.role}]\n${m.content}`)
          .join("\n\n");
        const { generateNameFromTranscript } = await import(
          "../ai-sessions/naming.js"
        );
        const newName = await generateNameFromTranscript(transcript);
        ai.name = newName;
        aiStore.write(ai);
        await api.sendMessage({ chat_id: chatId, text: `Renamed to: ${newName}` });
      } catch (e: any) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Rename failed: ${e?.message ?? e}`,
        });
      } finally {
        stopTyping();
      }
      return true;
    }

    if (cmd === "/skills") {
      const ai = aiStore.findByTelegramChat(chatId);
      const cwd = ai?.cwd ?? workspaceDir();
      const skills = listSkills(cwd);
      if (!skills.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: `No skills found under ${cwd}/skills/. Add SKILL.md files to advertise them.`,
        });
        return true;
      }
      const lines = [`Skills under ${cwd}/skills/:`];
      for (const s of skills) {
        lines.push(`• ${s.name}${s.description ? ` — ${s.description}` : ""}`);
      }
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
      return true;
    }

    if (cmd === "/interrupt") {
      // Existing logic in routeToSession also handles "/interrupt" prefix; this
      // path lets unbound chats get a clearer message.
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      await api.sendMessage({
        chat_id: chatId,
        text: "Interrupt requested. (Only effective if a run is live in this server process.)",
      });
      return true;
    }

    // Unrecognized slash command — let it fall through to plain-text routing.
    return false;
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
        label: `${s.id.slice(0, 4)} · ${s.provider} · ${s.name ?? "(unnamed)"}`.slice(0, 60),
        callback: `bind:${s.id}`,
      }));
    } else {
      header = `${provider} sessions:`;
      const sessions = await getProvider(provider).listSessions();
      entries = sessions.map((s) => ({
        id: s.id,
        // Path needed for preview enrichment below.
        label: `${s.id.slice(0, 4)} · ${s.cwd ?? ""}`.slice(0, 60),
        callback: `attach:${provider}:${s.id}`,
        path: s.path,
      })) as Array<{ id: string; label: string; callback: string; path?: string }>;
    }

    const start = page * PAGE_SIZE;
    const slice = entries.slice(start, start + PAGE_SIZE);
    // Enrich the visible slice with a cwd hint + first-message preview from
    // the JSONL. Cheap (one capped scan per row) — only the visible page.
    await Promise.all(
      slice.map(async (e: any) => {
        if (!e.path || !e.path.endsWith(".jsonl")) return;
        const { text, cwd } = await previewFromJsonl(e.path);
        const cwdHint = cwd ? shortenPath(cwd) : "";
        const parts = [e.id.slice(0, 4)];
        if (cwdHint) parts.push(cwdHint);
        if (text) parts.push(text);
        e.label = parts.join(" · ").slice(0, 60);
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
    // Backfill cwd for legacy AiSessions created before cwd was tracked.
    // Provider session storage (esp. claude) is keyed by cwd; resuming with
    // the wrong cwd surfaces "no conversation found".
    if (!s.cwd && s.sessionId) {
      try {
        const detail = await getProvider(s.provider).getSession(s.sessionId);
        if (detail.cwd) s.cwd = detail.cwd;
      } catch {
        /* best-effort */
      }
    }
    aiStore.write(s);
    await this.editTo(
      chatId,
      messageId,
      `Bound to Session ${s.id} (${s.provider}${s.name ? ` · ${s.name}` : ""}).`,
    );
    const pending = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (pending?.firstMessage || pending?.attachments?.length) {
      await this.routeToSession(
        s.id,
        pending?.firstMessage ?? "",
        chatId,
        pending?.attachments ?? []
      );
    }
  }

  // Wrap an existing provider-native session in a new AiSession and bind chat.
  private async attachProviderSession(
    chatId: number,
    messageId: number,
    provider: string,
    providerSessionId: string,
  ): Promise<void> {
    // Look up the underlying session's cwd so resumes work (claude scopes
    // session storage by directory).
    let sessionCwd: string | undefined;
    try {
      const detail = await getProvider(provider).getSession(providerSessionId);
      sessionCwd = detail.cwd;
    } catch {
      /* ignore */
    }
    let ai = aiStore.findByProviderSession(provider, providerSessionId);
    if (!ai) {
      ai = aiStore.create({ provider, sessionId: providerSessionId, cwd: sessionCwd });
    } else if (!ai.cwd && sessionCwd) {
      ai.cwd = sessionCwd;
    }
    ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
    aiStore.write(ai);
    await this.editTo(
      chatId,
      messageId,
      `Bound to Session ${ai.id} (${provider} · ${providerSessionId.slice(0, 4)}).`,
    );
    const pending = this.pending.get(chatId);
    this.pending.delete(chatId);
    if (pending?.firstMessage || pending?.attachments?.length) {
      await this.routeToSession(
        ai.id,
        pending?.firstMessage ?? "",
        chatId,
        pending?.attachments ?? []
      );
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
    if (pending?.firstMessage || pending?.attachments?.length) {
      await this.routeToSession(
        ai.id,
        pending?.firstMessage ?? "",
        chatId,
        pending?.attachments ?? []
      );
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
    attachments: Attachment[] = [],
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
    if (!trimmed && !attachments.length) return;
    const ai = aiStore.read(aiSessionId);
    if (!ai) {
      await this.api.sendMessage({ chat_id: chatId, text: "Session not found." });
      return;
    }
    const stopTyping = this.startTyping(chatId);
    const status = await this.openStatusBlock(chatId);
    if (attachments.length) {
      const summary = attachments
        .map((a) => `📎 ${a.filename ?? a.path.split(/[\\/]/).pop()}`)
        .join("\n");
      // Surface the attachment list at the top of the status block.
      status.push(summary);
    }
    try {
      const handle = getProvider(ai.provider).run({
        prompt: trimmed || "(see attachments)",
        attachments,
        aiSessionId: ai.id,
        cwd: workspaceDir(),
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
        const headHtml = markdownToTelegramHtml(head);
        try {
          await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: headHtml,
            parse_mode: "HTML",
          });
        } catch {
          // HTML rejected → retry plain.
          try {
            await api.editMessageText({
              chat_id: chatId,
              message_id: messageId,
              text: head,
            });
          } catch {
            /* ignore */
          }
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
