import * as aiStore from "../ai-sessions/store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { getLive } from "../runs/registry.js";
import { workspaceDir, defaultReasoningEffort, isReasoningEffort } from "../config.js";
import { listSkills } from "../skills/catalog.js";
import { previewFromJsonl, shortenPath } from "../sessions/preview.js";
import { markdownToTelegramHtml } from "./telegram-format.js";
import { downloadTelegramFile } from "./telegram-download.js";
import * as remoteControl from "./remote-control.js";
import * as sessionWatcher from "./session-watcher.js";
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
import type { AiSession } from "../ai-sessions/types.js";
import type { SessionDetail } from "../providers/types.js";

const PAGE_SIZE = 5;

const SLASH_COMMANDS = [
  { command: "help", description: "List available commands" },
  { command: "status", description: "Show this chat's bound session" },
  { command: "bind", description: "(Re)bind this chat to a Session" },
  { command: "unbind", description: "Remove this chat's binding from its Session" },
  { command: "new", description: "Start a new session on the current provider and bind this chat" },
  { command: "fork", description: "Fork the bound session to another provider: /fork <provider>" },
  { command: "remote", description: "Toggle claude remote-control: /remote [true|false]" },
  { command: "effort", description: "Set reasoning effort: /effort [low|medium|high|xhigh]" },
  { command: "watch", description: "Mirror new entries from this claude session into the chat" },
  { command: "unwatch", description: "Stop mirroring entries from this claude session" },
  { command: "cwd", description: "Show or set the bound session's cwd" },
  { command: "rename", description: "Rename the bound session (no arg = auto-summarize)" },
  { command: "skills", description: "List enabled skills in the workspace" },
  { command: "interrupt", description: "Interrupt the current run (best-effort)" },
  { command: "trace", description: "Show full detail of the last run (tools, inputs, outputs, reply)" },
  { command: "export", description: "Export the bound session's transcript as Markdown" },
  { command: "agent", description: "Run a one-shot sub-agent: /agent [<provider>] prompt" },
  { command: "btw", description: "Side question with full chat context, doesn't touch the bound session" },
  { command: "usage", description: "Show rate-limit usage across providers (5h / weekly windows)" },
  { command: "cron", description: "Manage scheduled prompts on this chat: /cron add|ls|rm" },
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
// Quiet window applied to every chat. Coalesces a forwarded text + document
// pair (which Telegram delivers as two updates) into a single dispatch so the
// bot doesn't answer the text before the file finishes uploading.
const CHAT_INBOX_FLUSH_MS = 1500;

interface ChatInbox {
  text: string;
  attachments: Attachment[];
  timer: NodeJS.Timeout | null;
}

interface TraceEvent {
  ts: number;
  type: "tool_use" | "tool_result" | "error";
  name?: string;
  input?: unknown;
  output?: unknown;
  message?: string;
}

interface TraceRecord {
  source: "route" | "agent" | "btw";
  label?: string;
  prompt: string;
  startedAt: number;
  finishedAt?: number;
  events: TraceEvent[];
  finalText?: string;
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

function rootKeyboard(opts: { showCancel?: boolean } = {}): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "Existing session", callback_data: "nav:exist" }],
    [{ text: "+ New session", callback_data: "nav:new" }],
  ];
  if (opts.showCancel) rows.push([{ text: "Cancel", callback_data: "nav:cancel" }]);
  return rows;
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
  // chatId → buffered text+attachments waiting for the quiet window.
  private chatInbox = new Map<number, ChatInbox>();
  // chatId → display name (group title or user first_name). Cached so the
  // picker doesn't pound getChat on every page render.
  private chatNameCache = new Map<number, string>();
  // chatId → most recent run trace (full tool inputs/outputs + final reply).
  // Overwritten on each new run so /trace shows the latest activity.
  private lastTrace = new Map<number, TraceRecord>();

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
    remoteControl.installShutdownHook();
    this.restoreWatchers();
    api
      .setMyCommands({ commands: SLASH_COMMANDS })
      .catch((e: any) => console.error("[telegram] setMyCommands failed:", e?.message ?? e));
    this.polling = true;
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    sessionWatcher.stopAll();
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

    // Slash commands take priority over everything else. Check both text and
    // caption so commands like /agent can ship with an attachment.
    const cmdText = m.text ?? m.caption ?? "";
    if (cmdText.startsWith("/")) {
      const handled = await this.handleSlashCommand(cmdText, chatId, m);
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
      this.enqueue(chatId, text, att ? [att] : []);
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
      this.enqueue(chatId, cap, att ? [att] : []);
      return;
    }

    // Plain text (already checked for slash commands above).
    this.enqueue(chatId, m.text ?? "", []);
  }

  // Coalesce inbound messages from a single chat that arrive within a quiet
  // window. Each new message resets the timer; when it finally fires we run
  // one combined dispatch.
  private enqueue(chatId: number, text: string, attachments: Attachment[]): void {
    let buf = this.chatInbox.get(chatId);
    if (!buf) {
      buf = { text: "", attachments: [], timer: null };
      this.chatInbox.set(chatId, buf);
    }
    if (text) buf.text = buf.text ? `${buf.text}\n${text}` : text;
    if (attachments.length) buf.attachments.push(...attachments);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      this.chatInbox.delete(chatId);
      void this.dispatch(chatId, buf!.text, buf!.attachments);
    }, CHAT_INBOX_FLUSH_MS);
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
    this.enqueue(chatId, transcribed, []);
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
      this.enqueue(buf!.chatId, buf!.caption, buf!.attachments);
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
  private async handleSlashCommand(text: string, chatId: number, m: any): Promise<boolean> {
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
      // Don't drop the existing binding up-front — picking a new session will
      // replace it, and cancel keeps the current one intact.
      this.pending.delete(chatId);
      const alreadyBound = aiStore.findByTelegramChat(chatId) != null;
      await this.sendBindingPicker(chatId, { showCancel: alreadyBound });
      return true;
    }

    if (cmd === "/unbind") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      sessionWatcher.stop(ai.id);
      ai.channels = { ...(ai.channels ?? {}) };
      delete ai.channels.telegram;
      aiStore.write(ai);
      this.pending.delete(chatId);
      await api.sendMessage({
        chat_id: chatId,
        text: `Unbound from Session ${ai.id.slice(0, 8)} (${ai.provider}${ai.name ? ` · ${ai.name}` : ""}).`,
      });
      return true;
    }

    if (cmd === "/new") {
      const current = aiStore.findByTelegramChat(chatId);
      const provider = arg.trim() || current?.provider;
      if (!provider) {
        await api.sendMessage({
          chat_id: chatId,
          text: "No bound session — pass a provider, e.g. /new claude.",
        });
        return true;
      }
      if (!listProviderNames().includes(provider)) {
        await api.sendMessage({ chat_id: chatId, text: `Unknown provider: ${provider}` });
        return true;
      }
      // Detach the chat from the previous session so the new one owns the binding.
      if (current) {
        current.channels = { ...(current.channels ?? {}) };
        delete current.channels.telegram;
        aiStore.write(current);
      }
      const ai = aiStore.create({ provider });
      ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
      aiStore.write(ai);
      this.pending.delete(chatId);
      await api.sendMessage({
        chat_id: chatId,
        text: `New Session ${ai.id.slice(0, 8)} (${provider}). Send a message to start.`,
      });
      return true;
    }

    if (cmd === "/remote") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      if (ai.provider !== "claude") {
        await api.sendMessage({
          chat_id: chatId,
          text: `Remote-control only works for claude sessions; this one is ${ai.provider}.`,
        });
        return true;
      }
      const a = arg.trim().toLowerCase();
      if (!a) {
        const running = remoteControl.isRunning(ai.id);
        await api.sendMessage({
          chat_id: chatId,
          text: running ? "Remote-control: ENABLED" : "Remote-control: disabled",
        });
        return true;
      }
      if (a === "true" || a === "on" || a === "1") {
        const r = remoteControl.start(ai);
        await api.sendMessage({
          chat_id: chatId,
          text: r.ok
            ? `Remote-control enabled (pid ${r.pid}). Log: ${r.logPath}`
            : `Failed to enable: ${r.error}`,
        });
        return true;
      }
      if (a === "false" || a === "off" || a === "0") {
        const stopped = remoteControl.stop(ai.id);
        await api.sendMessage({
          chat_id: chatId,
          text: stopped ? "Remote-control disabled." : "Remote-control was not running.",
        });
        return true;
      }
      await api.sendMessage({
        chat_id: chatId,
        text: "Usage: /remote [true|false]",
      });
      return true;
    }

    if (cmd === "/effort") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      const a = arg.trim().toLowerCase();
      if (!a) {
        const eff = ai.reasoningEffort ?? defaultReasoningEffort();
        await api.sendMessage({
          chat_id: chatId,
          text: `Reasoning effort: ${eff}${ai.reasoningEffort ? "" : " (default)"}`,
        });
        return true;
      }
      if (!isReasoningEffort(a)) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Usage: /effort [low|medium|high|xhigh]",
        });
        return true;
      }
      ai.reasoningEffort = a;
      aiStore.write(ai);
      await api.sendMessage({ chat_id: chatId, text: `Reasoning effort set to: ${a}` });
      return true;
    }

    if (cmd === "/watch") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      const r = await sessionWatcher.start(ai, this.makeForwardFn(chatId));
      if (!r.ok) {
        await api.sendMessage({ chat_id: chatId, text: `Watch failed: ${r.error}` });
        return true;
      }
      ai.watch = true;
      aiStore.write(ai);
      await api.sendMessage({
        chat_id: chatId,
        text: "Watching this session — new entries will mirror here.",
      });
      return true;
    }

    if (cmd === "/unwatch") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      sessionWatcher.stop(ai.id);
      ai.watch = false;
      aiStore.write(ai);
      await api.sendMessage({ chat_id: chatId, text: "Stopped watching." });
      return true;
    }

    if (cmd === "/fork") {
      const current = aiStore.findByTelegramChat(chatId);
      if (!current) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound — nothing to fork." });
        return true;
      }
      if (!current.sessionId) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Bound session has no provider session yet (send a message first).",
        });
        return true;
      }
      const target = arg.trim().toLowerCase();
      const choices = listProviderNames().filter((p) => p !== current.provider);
      if (!target) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Usage: /fork <provider>\nAvailable: ${choices.join(", ") || "(none)"}`,
        });
        return true;
      }
      if (!listProviderNames().includes(target)) {
        await api.sendMessage({ chat_id: chatId, text: `Unknown provider: ${target}` });
        return true;
      }
      if (target === current.provider) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Already on ${target}; pick a different provider to fork into.`,
        });
        return true;
      }
      const stopTyping = this.startTyping(chatId);
      const status = await api.sendMessage({
        chat_id: chatId,
        text: `🌿 Forking session into ${target}…`,
      });
      try {
        const { forkAiSession } = await import("../ai-sessions/fork.js");
        const result = await forkAiSession({
          sourceId: current.id,
          targetProvider: target,
          cwd: current.cwd,
        });
        // Rebind chat to the new fork.
        current.channels = { ...(current.channels ?? {}) };
        delete current.channels.telegram;
        aiStore.write(current);
        const fork = aiStore.read(result.id);
        if (fork) {
          // Auto-name so the fork is easy to spot in the picker later. Prefer
          // the chat's title; fall back to the source name or a generic label.
          const chatTitle = await this.resolveChatName(chatId);
          const base = chatTitle || current.name || "session";
          fork.name = `${base} fork ${shortStamp()}`;
          fork.channels = { ...(fork.channels ?? {}), telegram: { chatId } };
          aiStore.write(fork);
        }
        await api.editMessageText({
          chat_id: chatId,
          message_id: status.message_id,
          text: `Forked into ${target} (seed: ${result.seedMode}, ~${result.estimatedTokens} tokens). Chat now bound to ${result.id.slice(0, 8)}.`,
        });
      } catch (e: any) {
        await api.editMessageText({
          chat_id: chatId,
          message_id: status.message_id,
          text: `Fork failed: ${e?.message ?? e}`,
        });
      } finally {
        stopTyping();
      }
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

    if (cmd === "/agent" || cmd === "/btw") {
      const which = cmd.slice(1) as "agent" | "btw";
      const tail = text.replace(new RegExp(`^/${which}(?:@\\w+)?\\s*`, "i"), "");
      const provMatch = tail.match(/^<([^>]+)>\s*([\s\S]*)$/);
      const bound = aiStore.findByTelegramChat(chatId);
      const provider = (provMatch?.[1].trim() || bound?.provider || "claude").toLowerCase();
      const userPrompt = (provMatch ? provMatch[2] : tail).trim();
      if (!listProviderNames().includes(provider)) {
        await api.sendMessage({ chat_id: chatId, text: `Unknown provider: ${provider}` });
        return true;
      }
      let attachments: Attachment[] = [];
      if (m?.photo?.length) {
        const att = await this.downloadPhoto(m, chatId);
        if (att) attachments.push(att);
      } else if (m?.document || m?.video || m?.video_note) {
        const att = await this.downloadDocument(m, chatId);
        if (att) attachments.push(att);
      }
      if (!userPrompt && !attachments.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Usage: /${which} [<provider>] prompt`,
        });
        return true;
      }
      // Telegram-layer policy: front-load the bound session's transcript so
      // the sub-agent has context. /agent pipes its exchange back into the
      // bound session; /btw doesn't.
      const fullPrompt = await this.buildTranscriptPrefixedPrompt(bound, userPrompt);
      void this.runSubAgent(chatId, provider, fullPrompt, attachments, bound ?? undefined, {
        label: which,
        displayPrompt: userPrompt || "(see attachments)",
        pipeBack: which === "agent",
        fallbackPromptBuilder: bound?.sessionId
          ? () => this.buildSummarizedPrompt(bound, userPrompt)
          : undefined,
      });
      return true;
    }

    if (cmd === "/export") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      if (!ai.sessionId) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Nothing to export: no provider session yet (send a message first).",
        });
        return true;
      }
      const stopTyping = this.startTyping(chatId);
      try {
        const detail = await getProvider(ai.provider).getSession(ai.sessionId);
        const md = renderTranscriptMarkdown(ai, detail);
        const safeName = (ai.name ?? ai.id.slice(0, 8)).replace(/[^\w.-]+/g, "_");
        await api.sendDocument({
          chat_id: chatId,
          file: {
            bytes: Buffer.from(md, "utf8"),
            filename: `${safeName}.md`,
            mimeType: "text/markdown",
          },
          caption: `Transcript for Session ${ai.id.slice(0, 8)} (${detail.messages.length} messages)`,
        });
      } catch (e: any) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Export failed: ${e?.message ?? e}`,
        });
      } finally {
        stopTyping();
      }
      return true;
    }

    if (cmd === "/trace") {
      const trace = this.lastTrace.get(chatId);
      if (!trace) {
        await api.sendMessage({ chat_id: chatId, text: "No run trace yet for this chat." });
        return true;
      }
      const md = renderTraceMarkdown(trace);
      // Telegram message cap is ~4096; if we'd blow it, send as a file.
      if (md.length <= 3800) {
        await this.send({ chatId }, { text: md });
      } else {
        await api.sendDocument({
          chat_id: chatId,
          file: {
            bytes: Buffer.from(md, "utf8"),
            filename: `trace-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
            mimeType: "text/markdown",
          },
          caption: `Trace: ${trace.events.length} events${trace.finalText ? `, response ${trace.finalText.length} chars` : " (in progress)"}`,
        });
      }
      return true;
    }

    if (cmd === "/usage") {
      const { getUsage, formatUsage } = await import("../usage/index.js");
      const targets = arg ? arg.split(/\s+/).filter(Boolean) : ["claude", "glm", "codex"];
      const snaps = await Promise.all(targets.map((p) => getUsage(p)));
      const text = snaps.map((s) => formatUsage(s)).join("\n");
      await api.sendMessage({ chat_id: chatId, text });
      return true;
    }

    if (cmd === "/cron") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound. /bind a session first." });
        return true;
      }
      const cronStore = await import("../crons/store.js");
      const { makeJob, nextFireAfter } = await import("../crons/scheduler.js");

      const sub = (arg.split(/\s+/)[0] ?? "ls").toLowerCase();
      const rest = arg.slice(sub.length).trim();

      if (sub === "ls" || sub === "list" || sub === "") {
        const mine = cronStore.list().filter(
          (j) => j.target.kind === "ai_session" && j.target.aiSessionId === ai.id,
        );
        if (mine.length === 0) {
          await api.sendMessage({ chat_id: chatId, text: "No crons on this session." });
          return true;
        }
        const lines = mine.map(
          (j) =>
            `${j.enabled ? "on " : "off"}  ${j.name}  ${j.cron}  next=${j.nextRunAt}`,
        );
        await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
        return true;
      }

      if (sub === "rm" || sub === "remove" || sub === "delete") {
        const name = rest.trim();
        if (!name) {
          await api.sendMessage({ chat_id: chatId, text: "Usage: /cron rm <name>" });
          return true;
        }
        const j = cronStore.read(name);
        if (
          !j ||
          j.target.kind !== "ai_session" ||
          j.target.aiSessionId !== ai.id
        ) {
          await api.sendMessage({ chat_id: chatId, text: `No cron \"${name}\" on this session.` });
          return true;
        }
        cronStore.remove(name);
        await api.sendMessage({ chat_id: chatId, text: `removed: ${name}` });
        return true;
      }

      if (sub === "add") {
        // Cron expressions are 5 whitespace-separated fields; everything after
        // the 5th token is the prompt body.
        const m = /^(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/.exec(rest);
        if (!m) {
          await api.sendMessage({
            chat_id: chatId,
            text: 'Usage: /cron add <name> "<m h dom mon dow>" <prompt>\n' +
              'Example: /cron add standup "0 9 * * 1-5" Summarize yesterday and list 3 priorities for today',
          });
          return true;
        }
        const [, name, cron, prompt] = m;
        // Strip surrounding quotes from the cron expr if the user added them.
        const cronExpr = cron.replace(/^"|"$/g, "");
        try {
          // Validate by computing the next fire — throws on bad expressions.
          nextFireAfter(cronExpr, new Date(), "America/Chicago");
        } catch (e: any) {
          await api.sendMessage({
            chat_id: chatId,
            text: `Bad cron expression: ${e?.message ?? e}`,
          });
          return true;
        }
        if (cronStore.read(name)) {
          await api.sendMessage({
            chat_id: chatId,
            text: `cron \"${name}\" already exists; /cron rm ${name} first`,
          });
          return true;
        }
        const job = makeJob({
          name,
          cron: cronExpr,
          timezone: "America/Chicago",
          target: { kind: "ai_session", aiSessionId: ai.id, prompt: prompt.trim() },
        });
        cronStore.write(job);
        await api.sendMessage({
          chat_id: chatId,
          text: `added: ${job.name}\nnext=${job.nextRunAt}`,
        });
        return true;
      }

      await api.sendMessage({
        chat_id: chatId,
        text: "Subcommands: /cron add <name> \"<expr>\" <prompt> | /cron ls | /cron rm <name>",
      });
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

  private async sendBindingPicker(
    chatId: number,
    opts: { showCancel?: boolean } = {},
  ): Promise<void> {
    if (!this.api) return;
    const text = opts.showCancel
      ? "Pick an existing Session, create a new one, or cancel to keep the current binding."
      : "This group isn't bound to a Session yet. Pick an existing one or create a new one.";
    await this.api.sendMessage({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: rootKeyboard(opts) },
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
      header = "Saved sessions:";
      // Newest first — much friendlier when you have many.
      const sessions = aiStore
        .list()
        .slice()
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      entries = sessions.map((s) => ({
        id: s.id,
        label: "",
        callback: `bind:${s.id}`,
        aiSession: s,
      })) as Array<{ id: string; label: string; callback: string; aiSession?: AiSession }>;
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
    if (provider === "ai-sessions") {
      // Build a sessionId → JSONL path lookup for any visible AiSession that
      // lacks a name (so we can derive a preview line). Only fetch listSessions
      // for providers that appear in the visible slice.
      const providersNeeded = new Set<string>();
      for (const e of slice as any[]) {
        const ai = e.aiSession as AiSession | undefined;
        if (ai && !ai.name && ai.sessionId) providersNeeded.add(ai.provider);
      }
      const pathByKey = new Map<string, string>();
      await Promise.all(
        [...providersNeeded].map(async (p) => {
          try {
            const list = await getProvider(p).listSessions();
            for (const s of list) pathByKey.set(`${p}:${s.id}`, s.path);
          } catch {
            /* best-effort */
          }
        })
      );
      await Promise.all(
        (slice as any[]).map(async (e) => {
          const ai = e.aiSession as AiSession | undefined;
          if (!ai) return;
          let tgPrefix = "";
          const tgChatId = ai.channels?.telegram?.chatId;
          if (tgChatId) {
            const title = await this.resolveChatName(tgChatId);
            tgPrefix = title ? `📱 ${title} · ` : "📱 ";
          }
          let main = ai.name?.trim() || "";
          if (!main && ai.sessionId) {
            const path = pathByKey.get(`${ai.provider}:${ai.sessionId}`);
            if (path) {
              const { text } = await previewFromJsonl(path);
              if (text) main = text;
            }
          }
          if (!main) main = "(unnamed)";
          e.label = `${tgPrefix}${main} · ${ai.id.slice(0, 4)}`.slice(0, 60);
        })
      );
    } else {
      // Provider-native sessions: AiSession name (if any) + cwd hint + first-
      // message preview from JSONL.
      await Promise.all(
        (slice as any[]).map(async (e) => {
          if (!e.path || !e.path.endsWith(".jsonl")) return;
          const { text, cwd } = await previewFromJsonl(e.path);
          const cwdHint = cwd ? shortenPath(cwd) : "";
          const ai = aiStore.findByProviderSession(provider, e.id);
          const name = ai?.name?.trim();
          const parts = [e.id.slice(0, 4)];
          if (name) parts.push(name);
          if (cwdHint) parts.push(cwdHint);
          if (text) parts.push(text);
          e.label = parts.join(" · ").slice(0, 60);
        })
      );
    }
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

    if (data === "nav:cancel") {
      await this.editTo(chatId, messageId, "Cancelled — existing binding kept.");
      return;
    }
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

  // One-shot sub-agent: brand-new provider session, no AiSession persisted, no
  // chat binding. Shows a transient "agent running" status that gets deleted
  // once the run finishes; the final output is posted as a fresh message.
  private async runSubAgent(
    chatId: number,
    provider: string,
    prompt: string,
    attachments: Attachment[],
    bound: AiSession | undefined,
    opts: {
      label?: string;
      displayPrompt?: string;
      pipeBack?: boolean;
      // Called once if the first run fails with a "prompt too long"-style
      // error. Should return a shorter prompt to retry with (typically a
      // summarized transcript). Return null to give up and report the error.
      fallbackPromptBuilder?: () => Promise<string | null>;
    } = {},
  ): Promise<void> {
    const api = this.ensureApi();
    if (!api) return;
    const cwd = bound?.cwd;
    const label = opts.label ?? "agent";
    const stopTyping = this.startTyping(chatId);
    const lines: string[] = [`🤖 ${label} (${provider}) running…`];
    let statusId: number | null = null;
    let lastEditAt = 0;
    let pending: NodeJS.Timeout | null = null;
    const MIN_INTERVAL = 1500;
    const MAX_LINES = 12;
    const render = () => lines.join("\n").slice(0, 4000);
    const editNow = async () => {
      if (statusId == null) return;
      try {
        await api.editMessageText({ chat_id: chatId, message_id: statusId, text: render() });
        lastEditAt = Date.now();
      } catch {
        /* ignore */
      }
    };
    const schedule = () => {
      if (pending) return;
      const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastEditAt));
      pending = setTimeout(() => {
        pending = null;
        void editNow();
      }, wait);
    };
    try {
      const sent = await api.sendMessage({ chat_id: chatId, text: render() });
      statusId = sent.message_id;
      lastEditAt = Date.now();
      const trace: TraceRecord = {
        source: label === "btw" ? "btw" : "agent",
        label,
        prompt: opts.displayPrompt ?? (prompt || "(see attachments)"),
        startedAt: Date.now(),
        events: [],
      };
      this.lastTrace.set(chatId, trace);
      const attempt = async (p: string) => {
        const handle = getProvider(provider).run({
          prompt: p || "(see attachments)",
          attachments,
          cwd: cwd ?? workspaceDir(),
          yolo: true,
        });
        const live = getLive(handle.meta.runId);
        const watcher = (async () => {
          if (!live) return;
          for await (const ev of live.events) {
            if (ev.type === "tool_use") {
              const inputStr = formatToolInput(ev.input);
              lines.push(`🔧 ${ev.name}${inputStr ? `: ${inputStr}` : ""}`);
              trace.events.push({ ts: Date.now(), type: "tool_use", name: ev.name, input: ev.input });
            } else if (ev.type === "tool_result") {
              const last = lines[lines.length - 1];
              if (last && last.startsWith("🔧 ")) {
                lines[lines.length - 1] = last.replace(/^🔧/, "✓");
              }
              trace.events.push({ ts: Date.now(), type: "tool_result", name: ev.name, output: ev.output });
            } else if (ev.type === "error") {
              console.error("[telegram] sub-agent run error event:", ev.message);
              lines.push(`❌ ${ev.message}`);
              trace.events.push({ ts: Date.now(), type: "error", message: ev.message });
            }
            if (lines.length > MAX_LINES) lines.splice(1, lines.length - MAX_LINES);
            schedule();
          }
        })();
        const m = await handle.done;
        await watcher;
        return m;
      };

      let meta = await attempt(prompt);
      // If the first run blew the context window, ask the caller for a shorter
      // prompt (typically a summarized transcript) and try once more.
      if (meta.error && isContextOverflow(meta.error) && opts.fallbackPromptBuilder) {
        lines.push("♻️ context too long — summarizing and retrying…");
        if (lines.length > MAX_LINES) lines.splice(1, lines.length - MAX_LINES);
        schedule();
        try {
          const fallback = await opts.fallbackPromptBuilder();
          if (fallback) meta = await attempt(fallback);
        } catch (e: any) {
          console.error("[telegram] fallback prompt builder failed:", e?.message ?? e);
        }
      }
      if (meta.error) console.error("[telegram] sub-agent run failed:", meta.error);
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      if (statusId != null) {
        await api.deleteMessage({ chat_id: chatId, message_id: statusId }).catch(() => {});
        statusId = null;
      }
      const responseText =
        meta.output?.trim() ||
        (meta.error ? `Agent failed: ${meta.error}` : "(no output)");
      trace.finalText = responseText;
      trace.finishedAt = Date.now();
      const promptForDisplay = opts.displayPrompt ?? (prompt || "(see attachments)");
      const finalText = [
        `🤖 **${label}** (${provider})`,
        "",
        "**Request:**",
        promptForDisplay,
        "",
        "**Response:**",
        responseText,
      ].join("\n");
      await this.send({ chatId }, { text: finalText });
      // Forward the exchange into the bound session as a normal turn so the
      // session has it in history and replies visibly in Telegram.
      if (opts.pipeBack && bound && !meta.error) {
        const memo = [
          `Sub-agent (${provider}) was run on the side.`,
          "",
          "Request:",
          promptForDisplay,
          "",
          "Response:",
          responseText,
        ].join("\n");
        void this.routeToSession(bound.id, memo, chatId, []);
      }
    } catch (e: any) {
      console.error("[telegram] runSubAgent error:", e?.stack ?? e?.message ?? e);
      if (statusId != null) {
        await api.deleteMessage({ chat_id: chatId, message_id: statusId }).catch(() => {});
      }
      await api.sendMessage({ chat_id: chatId, text: `Agent error: ${e?.message ?? e}` });
    } finally {
      stopTyping();
    }
  }

  // Builds the forwarder used by session-watcher: pretty-prints role+text
  // and pushes it to the bound chat. Long messages are chunked by send().
  private makeForwardFn(chatId: number): sessionWatcher.ForwardFn {
    return (role, text) => {
      const prefix = role === "user" ? "👤" : "🤖";
      void this.send({ chatId }, { text: `${prefix} ${text}` });
    };
  }

  // On startup, resume watchers for every AiSession that opted in via /watch.
  private restoreWatchers(): void {
    for (const ai of aiStore.list()) {
      if (!ai.watch) continue;
      const chatId = ai.channels?.telegram?.chatId;
      if (!chatId) continue;
      void sessionWatcher.start(ai, this.makeForwardFn(chatId));
    }
  }

  // Look up the human-readable name for a chat id (group title or user first
  // name), with an in-memory cache. Returns "" if it can't be resolved.
  private async resolveChatName(chatId: number): Promise<string> {
    const cached = this.chatNameCache.get(chatId);
    if (cached !== undefined) return cached;
    const api = this.ensureApi();
    if (!api) return "";
    try {
      const c = await api.getChat(chatId);
      const name = c.title || c.username || c.first_name || "";
      this.chatNameCache.set(chatId, name);
      return name;
    } catch {
      this.chatNameCache.set(chatId, "");
      return "";
    }
  }

  // Builds a prompt that prefixes a SUMMARY of the bound session's transcript
  // (instead of the full transcript). Used as a fallback when the full-prompt
  // version overflows the context window.
  private async buildSummarizedPrompt(
    bound: AiSession,
    userPrompt: string,
  ): Promise<string | null> {
    if (!bound.sessionId) return null;
    try {
      const detail = await getProvider(bound.provider).getSession(bound.sessionId);
      const transcript = detail.messages
        .map((mm) => `[${mm.role}]\n${mm.content}`)
        .join("\n\n");
      const { summarizeTranscript } = await import("../ai-sessions/summarize.js");
      const summary = await summarizeTranscript(transcript);
      return [
        "You are a side agent answering a question about an ongoing Telegram conversation. The full transcript was too long to include — here is a summary instead. Answer the user's question directly.",
        "",
        "--- transcript summary ---",
        summary,
        "--- end summary ---",
        "",
        userPrompt,
      ].join("\n");
    } catch (e: any) {
      console.error("[telegram] buildSummarizedPrompt failed:", e?.message ?? e);
      return null;
    }
  }

  // Builds a prompt that prefixes the bound session's transcript as context.
  // Telegram-layer concern only — runSubAgent stays transcript-agnostic.
  private async buildTranscriptPrefixedPrompt(
    bound: AiSession | null | undefined,
    userPrompt: string,
  ): Promise<string> {
    if (!bound?.sessionId) return userPrompt;
    try {
      const detail = await getProvider(bound.provider).getSession(bound.sessionId);
      const transcript = detail.messages
        .map((mm) => `[${mm.role}]\n${mm.content}`)
        .join("\n\n");
      return [
        "You are a side agent answering a question about an ongoing Telegram conversation. The transcript so far is below for context. Answer the user's question directly.",
        "",
        "--- transcript begin ---",
        transcript,
        "--- transcript end ---",
        "",
        userPrompt,
      ].join("\n");
    } catch {
      return userPrompt;
    }
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
    const trace: TraceRecord = {
      source: "route",
      prompt: trimmed || "(see attachments)",
      startedAt: Date.now(),
      events: [],
    };
    this.lastTrace.set(chatId, trace);
    // Suppress the watcher for the duration of this run — anything our run
    // appends to the JSONL will already be shown via the status block.
    const unmute = sessionWatcher.mute(ai.id);
    try {
      const handle = getProvider(ai.provider).run({
        prompt: trimmed || "(see attachments)",
        attachments,
        aiSessionId: ai.id,
        // Honor the AiSession's cwd so the model can reach files in that
        // tree. Falls back to the global workspaceDir for unscoped sessions.
        cwd: ai.cwd ?? workspaceDir(),
        yolo: true,
        effort: ai.reasoningEffort ?? defaultReasoningEffort(),
      });
      const live = getLive(handle.meta.runId);
      const sentImagePaths = new Set<string>();
      const watcher = (async () => {
        if (!live) return;
        for await (const ev of live.events) {
          if (ev.type === "tool_use") {
            const inputStr = formatToolInput(ev.input);
            status.push(`🔧 ${ev.name}${inputStr ? `: ${inputStr}` : ""}`);
            trace.events.push({ ts: Date.now(), type: "tool_use", name: ev.name, input: ev.input });
          } else if (ev.type === "tool_result") {
            // Mark previous tool line as complete; light touch.
            status.markLastDone();
            trace.events.push({ ts: Date.now(), type: "tool_result", name: ev.name, output: ev.output });
          } else if (ev.type === "image") {
            try {
              const { readFileSync } = await import("node:fs");
              const { basename } = await import("node:path");
              let bytes: Buffer | null = null;
              let filename = "image.png";
              if (ev.path) {
                bytes = readFileSync(ev.path);
                filename = basename(ev.path);
              } else if (ev.bytes) {
                bytes = Buffer.from(ev.bytes, "base64");
              }
              if (bytes && this.api) {
                await this.api.sendPhoto({
                  chat_id: chatId,
                  photo: { bytes, filename, mimeType: ev.mimeType ?? "image/png" },
                });
                if (ev.path) sentImagePaths.add(ev.path);
              }
            } catch (e) {
              console.error("[telegram] sendPhoto failed:", e);
            }
          } else if (ev.type === "error") {
            console.error("[telegram] route run error event:", ev.message);
            status.push(`❌ ${ev.message}`);
            trace.events.push({ ts: Date.now(), type: "error", message: ev.message });
          }
        }
      })();

      const meta = await handle.done;
      await watcher; // make sure all events are reflected
      if (meta.error) console.error("[telegram] route run failed:", meta.error);
      const finalText =
        meta.output?.trim() ||
        (meta.error ? `Run failed: ${meta.error}` : "(no output)");
      trace.finalText = finalText;
      trace.finishedAt = Date.now();
      // Heuristic: when the agent returns a local image path (e.g. from a
      // sub-skill that hits a different ai-sessions run we never saw), scan
      // the final text + captured tool outputs and auto-send any image files
      // we haven't already pushed via an image event.
      try {
        const haystacks: string[] = [finalText];
        for (const e of trace.events) {
          if (e.type === "tool_result") haystacks.push(stringifyOutput(e.output));
        }
        const re = /(?:[A-Za-z]:[\\/]|[\\/])[^\s"'`<>|*?]*?\.(?:png|jpe?g|gif|webp)\b/gi;
        const seen = new Set<string>();
        const { existsSync, statSync, readFileSync } = await import("node:fs");
        const { basename } = await import("node:path");
        for (const h of haystacks) {
          for (const m of h.matchAll(re)) {
            const p = m[0];
            if (seen.has(p) || sentImagePaths.has(p)) continue;
            seen.add(p);
            if (!existsSync(p)) continue;
            const st = statSync(p);
            // Skip absurdly large files; Telegram caps photos at 10MB.
            if (!st.isFile() || st.size > 9 * 1024 * 1024) continue;
            const bytes = readFileSync(p);
            const ext = p.split(".").pop()?.toLowerCase();
            const mimeType =
              ext === "png" ? "image/png" :
              ext === "gif" ? "image/gif" :
              ext === "webp" ? "image/webp" : "image/jpeg";
            try {
              if (this.api) {
                await this.api.sendPhoto({
                  chat_id: chatId,
                  photo: { bytes, filename: basename(p), mimeType },
                });
              }
            } catch (e) {
              console.error("[telegram] auto-sendPhoto failed:", e);
            }
          }
        }
      } catch (e) {
        console.error("[telegram] image-path scan failed:", e);
      }
      await status.finalize(finalText);
    } catch (e: any) {
      console.error("[telegram] routeToSession error:", e?.stack ?? e?.message ?? e);
      trace.finalText = `Error: ${e?.message ?? e}`;
      trace.finishedAt = Date.now();
      await status.finalize(`Error: ${e?.message ?? e}`);
    } finally {
      stopTyping();
      unmute();
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

function renderTraceMarkdown(trace: TraceRecord): string {
  const lines: string[] = [];
  const dur = trace.finishedAt
    ? `${((trace.finishedAt - trace.startedAt) / 1000).toFixed(1)}s`
    : `${((Date.now() - trace.startedAt) / 1000).toFixed(1)}s (in progress)`;
  lines.push(`# Trace — ${trace.source}${trace.label ? ` (${trace.label})` : ""}`);
  lines.push("");
  lines.push(`- Started: ${new Date(trace.startedAt).toISOString()}`);
  lines.push(`- Duration: ${dur}`);
  lines.push(`- Events: ${trace.events.length}`);
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push("```");
  lines.push(trace.prompt);
  lines.push("```");
  lines.push("");
  lines.push("## Events");
  lines.push("");
  for (let i = 0; i < trace.events.length; i++) {
    const ev = trace.events[i];
    const t = `+${((ev.ts - trace.startedAt) / 1000).toFixed(1)}s`;
    if (ev.type === "tool_use") {
      lines.push(`### ${i + 1}. 🔧 ${ev.name ?? "tool"} (${t})`);
      lines.push("");
      lines.push("```json");
      lines.push(safeStringify(ev.input));
      lines.push("```");
    } else if (ev.type === "tool_result") {
      lines.push(`### ${i + 1}. ✓ ${ev.name ?? "tool result"} (${t})`);
      lines.push("");
      lines.push("```");
      lines.push(stringifyOutput(ev.output));
      lines.push("```");
    } else if (ev.type === "error") {
      lines.push(`### ${i + 1}. ❌ error (${t})`);
      lines.push("");
      lines.push("```");
      lines.push(ev.message ?? "");
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("## Response");
  lines.push("");
  lines.push(trace.finalText ?? "(in progress)");
  return lines.join("\n");
}

function safeStringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function stringifyOutput(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return safeStringify(v);
}

function isContextOverflow(message: string | null | undefined): boolean {
  if (!message) return false;
  // Cap the keyword check to short error messages — a long stack trace that
  // incidentally mentions "context" or "tokens" shouldn't trigger a retry.
  if (message.length > 500) return false;
  const m = message.toLowerCase();
  return (
    m.includes("prompt is too long") ||
    m.includes("input is too long") ||
    m.includes("context length") ||
    m.includes("token limit") ||
    m.includes("max_tokens") ||
    m.includes("too many tokens")
  );
}

function shortStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderTranscriptMarkdown(ai: AiSession, detail: SessionDetail): string {
  const header = [
    `# ${ai.name ?? "(unnamed)"}`,
    "",
    `- Session: \`${ai.id}\``,
    `- Provider: ${ai.provider}`,
    `- Provider session: \`${ai.sessionId ?? ""}\``,
    `- cwd: ${ai.cwd ?? "(unset)"}`,
    `- Messages: ${detail.messages.length}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].join("\n");
  const body = detail.messages
    .map((m) => {
      const ts = m.timestamp ? ` _(${m.timestamp})_` : "";
      return `## ${m.role}${ts}\n\n${m.content}\n`;
    })
    .join("\n");
  return header + body;
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
