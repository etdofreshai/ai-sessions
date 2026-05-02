import * as aiStore from "../ai-sessions/store.js";
import { getProvider, listProviderNames } from "../providers/index.js";
import { getLive } from "../runs/registry.js";
import { workspaceDir, isReasoningEffort } from "../config.js";
import {
  resolveProviderEffort,
  setProviderDefaultEffort,
  getProviderDefaultEffort,
} from "../providers/defaults.js";
import { listSkills } from "../skills/catalog.js";
import {
  SKILLS_ADVERTISE_KEY,
  buildSkillCommands,
  findSkillByCommand,
  skillCommandName,
} from "../skills/commands.js";
import { getBoolSetting, setBoolSetting } from "../settings.js";
import { previewFromJsonl, shortenPath } from "../sessions/preview.js";
import { markdownToTelegramHtml } from "./telegram-format.js";
import { openStatusBlock } from "./telegram-status.js";
import * as turnsRegistry from "../turns/registry.js";
import {
  type TraceRecord,
  formatToolInput,
  renderTraceMarkdown,
  renderTranscriptMarkdown,
  isContextOverflow,
  shortStamp,
  stringifyOutput,
  truncateForPreview,
  extractSkillIntro,
  chunk,
  sleep,
} from "./telegram-utils.js";
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
import type { AiSession } from "../ai-sessions/types.js";
import type { SessionDetail } from "../providers/types.js";

const PAGE_SIZE = 5;

const SLASH_COMMANDS = [
  { command: "help", description: "List available commands" },
  { command: "status", description: "Show this chat's bound session" },
  { command: "bind", description: "Bind this chat to a Session: /bind | /bind off" },
  { command: "new", description: "Start a new session: /new [<provider>] [<cwd>]" },
  { command: "fork", description: "Fork the bound session: /fork (same provider) | /fork <provider>" },
  { command: "effort", description: "Set reasoning effort: /effort [low|medium|high|xhigh] | /effort default <level>" },
  { command: "cwd", description: "Show the bound session's cwd (read-only — use /new or /fork to switch)" },
  { command: "rename", description: "Rename the bound session (no arg = auto-summarize)" },
  { command: "skills", description: "List skills, toggle ads, refresh menu: /skills | /skills on|off | /skills refresh" },
  { command: "stop", description: "Interrupt the current run on this session" },
  { command: "trace", description: "Show full detail of the last run (tools, inputs, outputs, reply)" },
  { command: "export", description: "Export the bound session's transcript as Markdown" },
  { command: "btw", description: "Side question with full chat context, doesn't touch the bound session" },
  { command: "usage", description: "Show rate-limit usage across providers (5h / weekly windows)" },
  { command: "cron", description: "Manage scheduled prompts on this chat: /cron add|ls|rm" },
  { command: "version", description: "Show server's git commit, or git status of a path: /version [<dir>]" },
  { command: "ls", description: "List files in a directory on the server: /ls [<dir>]" },
  { command: "subagents", description: "List subagents for the bound session with status + idle" },
  { command: "workspace", description: "Sync the workspace repo: /workspace pull | push" },
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
    void this.refreshCommandMenu();
    if (process.env.AI_SESSIONS_DISABLE_POLLING === "1") {
      console.log("[telegram] AI_SESSIONS_DISABLE_POLLING=1 — sending only, not polling");
      return;
    }
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
    // 409 ("Conflict: terminated by other getUpdates request") happens when
    // another instance is polling the same bot token. Log once on the first
    // hit and stay quiet until polling recovers — otherwise the loop spams
    // the same line every 2s indefinitely.
    let conflictLogged = false;
    while (this.polling && this.api) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });
        if (conflictLogged) {
          console.log("[telegram] poll recovered (no longer competing for getUpdates)");
          conflictLogged = false;
        }
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((e) => {
            console.error("[telegram] handler error:", e?.message ?? e);
          });
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        const isConflict = /Conflict:\s*terminated by other getUpdates/i.test(msg);
        if (isConflict) {
          if (!conflictLogged) {
            console.error(
              "[telegram] poll conflict — another process is polling the same bot token. " +
                "Set AI_SESSIONS_DISABLE_POLLING=1 on this instance, or use a different " +
                "TELEGRAM_BOT_TOKEN. Backing off; will not log again until recovered.",
            );
            conflictLogged = true;
          }
          await sleep(15_000);
        } else {
          console.error("[telegram] poll error:", msg);
          await sleep(2000);
        }
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
      const chatType = m?.chat?.type ?? "?";
      const chatTitle = m?.chat?.title ?? m?.chat?.username ?? "";
      const threadId = m?.message_thread_id;
      const messageId = m?.message_id;
      const ai = aiStore.findByTelegramChat(chatId);
      const header = [
        `Chat: ${chatId}${chatTitle ? ` (${chatTitle})` : ""} [${chatType}]`,
        threadId != null ? `Thread: ${threadId}` : null,
        messageId != null ? `Message: ${messageId}` : null,
      ].filter(Boolean) as string[];
      if (!ai) {
        await api.sendMessage({
          chat_id: chatId,
          text: [...header, "", "Not bound. Send /bind to pick a Session."].join("\n"),
        });
        return true;
      }
      const lines = [
        ...header,
        "",
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
      // /bind off — drop the chat's existing binding (replaces the old
      // /unbind command).
      if (arg.trim().toLowerCase() === "off") {
        const ai = aiStore.findByTelegramChat(chatId);
        if (!ai) {
          await api.sendMessage({ chat_id: chatId, text: "Not bound." });
          return true;
        }
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
      // Default: open the binding picker. Don't drop the existing binding
      // up-front — picking a new session will replace it, and cancel keeps
      // the current one intact.
      this.pending.delete(chatId);
      const alreadyBound = aiStore.findByTelegramChat(chatId) != null;
      await this.sendBindingPicker(chatId, { showCancel: alreadyBound });
      return true;
    }

    if (cmd === "/new") {
      const current = aiStore.findByTelegramChat(chatId);
      // Format: /new [<provider>] [<cwd>]
      // Both args optional. Provider defaults to the current binding's
      // provider; cwd defaults to the current binding's cwd.
      const m = /^(\S+)?(?:\s+(.+))?$/.exec(arg.trim());
      const provider = (m?.[1] || current?.provider) ?? null;
      const cwdArg = m?.[2]?.trim();
      if (!provider) {
        await api.sendMessage({
          chat_id: chatId,
          text: "No bound session — pass a provider, e.g. /new claude [<cwd>].",
        });
        return true;
      }
      if (!listProviderNames().includes(provider)) {
        await api.sendMessage({ chat_id: chatId, text: `Unknown provider: ${provider}` });
        return true;
      }
      // Resolve cwd: explicit arg wins, falls back to inheriting from the
      // previous binding so chats already working under a specific tree
      // keep operating there. Relative paths resolve against the previous
      // cwd (or workspaceDir if there isn't one).
      let cwd: string | undefined;
      if (cwdArg) {
        const { isAbsolute, resolve } = await import("node:path");
        cwd = isAbsolute(cwdArg)
          ? cwdArg
          : resolve(current?.cwd ?? workspaceDir(), cwdArg);
      } else {
        cwd = current?.cwd;
      }
      // Detach the chat from the previous session so the new one owns the binding.
      if (current) {
        current.channels = { ...(current.channels ?? {}) };
        delete current.channels.telegram;
        aiStore.write(current);
      }
      const ai = aiStore.create({ provider, cwd });
      ai.channels = { ...(ai.channels ?? {}), telegram: { chatId } };
      aiStore.write(ai);
      this.pending.delete(chatId);
      await api.sendMessage({
        chat_id: chatId,
        text:
          `New Session ${ai.id.slice(0, 8)} (${provider})` +
          (ai.cwd ? `\ncwd: ${ai.cwd}` : "") +
          `\nSend a message to start.`,
      });
      return true;
    }

    if (cmd === "/effort") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      const trimmed = arg.trim();
      const tokens = trimmed.split(/\s+/).filter(Boolean);

      // /effort default <level> — set the provider-wide default for new
      // sessions (doesn't touch this session's own override). Affects every
      // future AiSession on this provider that doesn't have an explicit
      // /effort set.
      if (tokens[0]?.toLowerCase() === "default") {
        const level = tokens[1]?.toLowerCase();
        if (!level || !isReasoningEffort(level)) {
          await api.sendMessage({
            chat_id: chatId,
            text: "Usage: /effort default [low|medium|high|xhigh]",
          });
          return true;
        }
        setProviderDefaultEffort(ai.provider, level);
        await api.sendMessage({
          chat_id: chatId,
          text: `For provider ${ai.provider}, the default effort for new sessions will be: ${level}`,
        });
        return true;
      }

      // /effort — show this session's effort + the resolution chain.
      if (!trimmed) {
        const sessionOverride = ai.reasoningEffort;
        const providerDefault = getProviderDefaultEffort(ai.provider);
        const effective = sessionOverride ?? resolveProviderEffort(ai.provider);
        const lines = [`Reasoning effort: ${effective}`];
        if (sessionOverride) {
          lines.push(`  · session override: ${sessionOverride}`);
        }
        if (providerDefault) {
          lines.push(`  · ${ai.provider} default: ${providerDefault}`);
        } else {
          lines.push(`  · ${ai.provider} default: (env / "low")`);
        }
        await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
        return true;
      }

      // /effort <level> — set just this session's override.
      const a = trimmed.toLowerCase();
      if (!isReasoningEffort(a)) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Usage: /effort [low|medium|high|xhigh] | /effort default <level>",
        });
        return true;
      }
      ai.reasoningEffort = a;
      aiStore.write(ai);
      await api.sendMessage({ chat_id: chatId, text: `Reasoning effort set to: ${a}` });
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
      // /fork → same provider; /fork <provider> → cross-provider. Both use
      // the markdown-attachment seeding path so the new agent gets the
      // entire transcript without bloating its first prompt.
      const target = (arg.trim() || current.provider).toLowerCase();
      if (!listProviderNames().includes(target)) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Unknown provider: ${target}\nAvailable: ${listProviderNames().join(", ")}`,
        });
        return true;
      }
      const stopTyping = this.startTyping(chatId);
      const status = await api.sendMessage({
        chat_id: chatId,
        text:
          target === current.provider
            ? `🌿 Forking session (same provider: ${target})…`
            : `🌿 Forking session ${current.provider} → ${target}…`,
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
          text: `Forked into ${target} (${result.messageCount} messages attached as markdown). Chat now bound to ${result.id.slice(0, 8)}.`,
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
      // Show-only. Provider session storage (esp. claude) is keyed by cwd —
      // mutating it after the session was created loses the resume. Use
      // /new <provider> <cwd> or /fork to start somewhere else.
      const lines = [`cwd: ${ai.cwd ?? "(unset)"}`];
      if (arg.trim()) {
        lines.push("(read-only — use /new or /fork to switch directories)");
      }
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
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
      const sub = arg.trim().toLowerCase();
      // /skills on|off — toggle whether each skill is advertised as its
      // own slash command in the Telegram menu. Re-publishes the menu
      // immediately so the change is visible without a restart.
      if (sub === "on" || sub === "off") {
        setBoolSetting(SKILLS_ADVERTISE_KEY, sub === "on");
        await this.refreshCommandMenu();
        await api.sendMessage({
          chat_id: chatId,
          text:
            sub === "on"
              ? "Skills will be advertised as individual slash commands. Tap the menu to refresh."
              : "Skills will no longer appear in the slash menu. Direct typing of /<skill> still works.",
        });
        return true;
      }
      // /skills refresh — re-scan the skills/ directory and re-publish the
      // bot menu. Use after adding a new skill, renaming a SKILL.md, or
      // editing a frontmatter description. The skill list itself is read
      // fresh on every dispatch, so this is purely about the Telegram
      // menu — direct typing of /<skill> always picks up new skills
      // immediately without refreshing.
      if (sub === "refresh") {
        const before = buildSkillCommands(workspaceDir()).length;
        await this.refreshCommandMenu();
        const after = buildSkillCommands(workspaceDir()).length;
        await api.sendMessage({
          chat_id: chatId,
          text: `Skills menu refreshed (${after} skill${after === 1 ? "" : "s"} advertised${
            before !== after ? `, was ${before}` : ""
          }). Tap the menu to see the new list.`,
        });
        return true;
      }
      const ai = aiStore.findByTelegramChat(chatId);
      const cwd = ai?.cwd ?? workspaceDir();
      const skills = listSkills(cwd);
      const advertising = getBoolSetting(SKILLS_ADVERTISE_KEY, true);
      const headerLines = [
        `Skills under ${cwd}/skills/`,
        `Advertised as slash commands: ${advertising ? "on" : "off"} (toggle: /skills on | /skills off)`,
        "",
      ];
      if (!skills.length) {
        headerLines.push("No skills found. Add SKILL.md files to advertise them.");
        await api.sendMessage({ chat_id: chatId, text: headerLines.join("\n") });
        return true;
      }
      const blocks = [...headerLines];
      for (const s of skills) {
        const cmdName = skillCommandName(s);
        const tag = cmdName ? `/${cmdName}` : `(skipped: name not a valid command)`;
        blocks.push(`**${s.name}** — ${tag}`);
        if (s.description) blocks.push(s.description);
        blocks.push("");
      }
      await this.send({ chatId }, { text: blocks.join("\n").trimEnd() });
      return true;
    }

    if (cmd === "/btw") {
      const which = "btw" as const;
      const tail = text.replace(/^\/btw(?:@\w+)?\s*/i, "");
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
      // /btw front-loads the bound session's transcript so the side agent
      // has context, but doesn't pipe its reply back into the session.
      const fullPrompt = await this.buildTranscriptPrefixedPrompt(bound, userPrompt);
      void this.runSubAgent(chatId, provider, fullPrompt, attachments, bound ?? undefined, {
        label: which,
        displayPrompt: userPrompt || "(see attachments)",
        pipeBack: false,
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

    if (cmd === "/ls") {
      const target = arg.trim() || ".";
      const { resolve, isAbsolute } = await import("node:path");
      const { workspaceDir } = await import("../config.js");
      const ai = aiStore.findByTelegramChat(chatId);
      const baseDir = ai?.cwd ?? workspaceDir();
      const path = isAbsolute(target) ? target : resolve(baseDir, target);
      const { existsSync, statSync, readdirSync } = await import("node:fs");
      if (!existsSync(path)) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\n(does not exist)`,
        });
        return true;
      }
      let st;
      try {
        st = statSync(path);
      } catch (e: any) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\n(stat failed: ${e?.message ?? e})`,
        });
        return true;
      }
      if (!st.isDirectory()) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\nType:    file\nSize:    ${st.size} bytes`,
        });
        return true;
      }
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(path, { withFileTypes: true });
      } catch (e: any) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\n(readdir failed: ${e?.message ?? e})`,
        });
        return true;
      }
      entries.sort((a, b) => {
        // Directories first, then alphabetical.
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      const MAX = 200;
      const shown = entries.slice(0, MAX);
      const lines = [
        `Path: ${path}`,
        `Items: ${entries.length}${entries.length > MAX ? ` (showing first ${MAX})` : ""}`,
        "",
        ...shown.map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)),
      ];
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
      return true;
    }

    if (cmd === "/subagents") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Not bound. Send /bind to pick a Session first.",
        });
        return true;
      }
      const taskStore = await import("../sub-agent-tasks/store.js");
      const all = taskStore.list({ aiSessionId: ai.id });
      if (!all.length) {
        await api.sendMessage({
          chat_id: chatId,
          text: `No subagents for session ${ai.id.slice(0, 8)}.`,
        });
        return true;
      }
      const now = Date.now();
      const STATUS_ICON: Record<string, string> = {
        created: "⏸",
        running: "▶️",
        completed: "✅",
        failed: "❌",
        merge_failed: "⚠️",
        cancelled: "🚫",
      };
      const fmtSec = (ms: number): string => {
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.floor(s / 60)}m`;
        return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
      };
      // Sort: running first, then created, then terminal — newest first within each.
      const order: Record<string, number> = {
        running: 0,
        created: 1,
        merge_failed: 2,
        failed: 3,
        cancelled: 4,
        completed: 5,
      };
      all.sort((a, b) => {
        const oa = order[a.status] ?? 9;
        const ob = order[b.status] ?? 9;
        if (oa !== ob) return oa - ob;
        return b.createdAt.localeCompare(a.createdAt);
      });
      const lines: string[] = [
        `Subagents for session ${ai.id.slice(0, 8)} (${all.length}):`,
        "",
      ];
      const counts: Record<string, number> = {};
      for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
      const summary = Object.entries(counts)
        .map(([s, n]) => `${STATUS_ICON[s] ?? "·"} ${s}=${n}`)
        .join("  ");
      lines.push(summary, "");
      const MAX = 30;
      for (const t of all.slice(0, MAX)) {
        const icon = STATUS_ICON[t.status] ?? "·";
        const ageSec = fmtSec(now - Date.parse(t.updatedAt));
        const updated =
          t.status === "running"
            ? ` idle=${ageSec}`
            : ` upd=${ageSec}`;
        const dur =
          t.startedAt && t.finishedAt
            ? ` dur=${fmtSec(Date.parse(t.finishedAt) - Date.parse(t.startedAt))}`
            : "";
        const msgs = t.activityCount != null ? ` msgs=${t.activityCount}` : "";
        const prov = t.provider ? ` [${t.provider}]` : "";
        const title = (t.title ?? "").slice(0, 60);
        lines.push(
          `${icon} ${t.id.slice(0, 8)}${prov} ${t.status}${updated}${dur}${msgs} — ${title}`,
        );
      }
      if (all.length > MAX) lines.push("", `(showing ${MAX} of ${all.length})`);
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
      return true;
    }

    if (cmd === "/workspace") {
      const sub = arg.trim().toLowerCase().split(/\s+/)[0];
      if (sub !== "pull" && sub !== "push") {
        await api.sendMessage({
          chat_id: chatId,
          text: "Usage: /workspace pull | /workspace push",
        });
        return true;
      }
      const { workspaceDir } = await import("../config.js");
      const wsDir = workspaceDir();
      const { spawn } = await import("node:child_process");
      const runGit = (gitArgs: string[]): Promise<{ code: number; out: string }> =>
        new Promise((resolve) => {
          const child = spawn("git", gitArgs, {
            cwd: wsDir,
            shell: false,
            env: process.env,
          });
          let buf = "";
          child.stdout.on("data", (d) => (buf += d.toString()));
          child.stderr.on("data", (d) => (buf += d.toString()));
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
            resolve({ code: 124, out: buf + "\n[timed out after 60s]" });
          }, 60_000);
          child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: 127, out: buf + `\n[spawn error: ${e.message}]` });
          });
          child.on("exit", (code) => {
            clearTimeout(timer);
            resolve({ code: code ?? 0, out: buf });
          });
        });
      const stopTyping = this.startTyping(chatId);
      try {
        // Resolve the current branch so pull/push work even without an
        // upstream-tracking ref configured. (Some deployed workspaces
        // were checked out detached or via a fetch that didn't set
        // upstream — passing `origin <branch>` explicitly avoids
        // "no tracking information" errors.)
        const { code: brCode, out: brOut } = await runGit([
          "rev-parse", "--abbrev-ref", "HEAD",
        ]);
        const branch = brOut.trim();
        if (brCode !== 0 || !branch || branch === "HEAD") {
          await api.sendMessage({
            chat_id: chatId,
            text: `❌ couldn't resolve workspace branch (cwd=${wsDir}, exit=${brCode})\n\n${brOut.trim().slice(0, 1500)}`,
          });
          return true;
        }
        const args =
          sub === "pull"
            ? ["pull", "--rebase", "--autostash", "origin", branch]
            : ["push", "origin", branch];
        const { code, out } = await runGit(args);
        const trimmed = (out || "(no output)").trim().slice(0, 3500);
        const icon = code === 0 ? "✅" : "❌";
        await api.sendMessage({
          chat_id: chatId,
          text: `${icon} git ${args.join(" ")} (cwd=${wsDir}, exit=${code})\n\n${trimmed}`,
        });
      } finally {
        stopTyping();
      }
      return true;
    }

    if (cmd === "/version" || cmd === "/sha") {
      const target = arg.trim();
      // No arg → server build SHA from baked env / runtime detection.
      if (!target) {
        const { GIT, VERSION } = await import("../version.js");
        const text = [
          `Version: ${VERSION}`,
          `Branch:  ${GIT.branch}`,
          `Commit:  ${GIT.shortSha} (${GIT.sha})`,
        ].join("\n");
        await api.sendMessage({ chat_id: chatId, text });
        return true;
      }
      // Arg → run `git -C <path>` and report. Resolve relative paths against
      // the bound AiSession's cwd if any, otherwise the workspace dir.
      const { resolve, isAbsolute } = await import("node:path");
      const { workspaceDir } = await import("../config.js");
      const ai = aiStore.findByTelegramChat(chatId);
      const baseDir = ai?.cwd ?? workspaceDir();
      const path = isAbsolute(target) ? target : resolve(baseDir, target);
      const { existsSync } = await import("node:fs");
      if (!existsSync(path)) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\n(does not exist on this server's filesystem)`,
        });
        return true;
      }
      const { execFileSync } = await import("node:child_process");
      const tryGit = (
        args: string[],
      ): { ok: boolean; out: string } => {
        try {
          const out = execFileSync("git", ["-C", path, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          return { ok: true, out };
        } catch (e: any) {
          return {
            ok: false,
            out: (e?.stderr?.toString() || e?.message || "").trim(),
          };
        }
      };
      const sha = tryGit(["rev-parse", "HEAD"]);
      if (!sha.ok) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Path:    ${path}\n(${sha.out || "not a git repo"})`,
        });
        return true;
      }
      const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
      const remote = tryGit(["remote", "get-url", "origin"]);
      const status = tryGit(["status", "--porcelain"]);
      const dirtyCount =
        status.ok && status.out ? status.out.split("\n").length : 0;
      const lines = [
        `Path:    ${path}`,
        `Remote:  ${remote.ok ? remote.out : "(none)"}`,
        `Branch:  ${branch.ok ? branch.out : "(?)"}`,
        `Commit:  ${sha.out.slice(0, 7)} (${sha.out})`,
        `Dirty:   ${dirtyCount > 0 ? `yes (${dirtyCount} files)` : "no"}`,
      ];
      await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
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

    if (cmd === "/stop") {
      const ai = aiStore.findByTelegramChat(chatId);
      if (!ai) {
        await api.sendMessage({ chat_id: chatId, text: "Not bound." });
        return true;
      }
      const turn = turnsRegistry.getByAiSession(ai.id);
      if (!turn?.handle) {
        await api.sendMessage({
          chat_id: chatId,
          text: "No live run on this session in this process.",
        });
        return true;
      }
      try {
        await turn.handle.interrupt();
        await api.sendMessage({ chat_id: chatId, text: "Interrupted." });
      } catch (e: any) {
        await api.sendMessage({
          chat_id: chatId,
          text: `Interrupt failed: ${e?.message ?? e}`,
        });
      }
      return true;
    }

    // Skill-as-slash-command dispatch. /<skill_name> with no args shows
    // the skill's header (description + intro paragraph) so the user can
    // see what it does without running it. /<skill_name> <args> routes a
    // turn to the bound session with the skill's absolute SKILL.md path.
    // Direct typing of either form works regardless of /skills on/off.
    const skillName = cmd.slice(1).split("@")[0]; // strip @botname suffix
    const ai = aiStore.findByTelegramChat(chatId);
    const cwd = ai?.cwd ?? workspaceDir();
    const skill = findSkillByCommand(cwd, skillName);
    if (skill) {
      const skillArgs = arg.trim();
      // No-arg → show header. Cheap "what does this skill do" affordance
      // without the LLM round-trip.
      if (!skillArgs) {
        const { readFileSync } = await import("node:fs");
        let intro = "";
        try {
          intro = extractSkillIntro(readFileSync(skill.path, "utf8"));
        } catch (e: any) {
          intro = `(failed to read SKILL.md: ${e?.message ?? e})`;
        }
        const blocks = [
          `**${skill.name}** — /${skillName}`,
          skill.description,
          "",
          intro,
          "",
          `To run: \`/${skillName} <args>\``,
        ].filter(Boolean);
        await this.send({ chatId }, { text: blocks.join("\n") });
        return true;
      }
      // With args → run.
      if (!ai) {
        await api.sendMessage({
          chat_id: chatId,
          text: "Not bound — /bind a session first to run skills here.",
        });
        return true;
      }
      const promptParts = [
        `Run the \`${skill.name}\` skill (full instructions at ${skill.path}).`,
        "",
        "User arguments:",
        skillArgs,
        "",
        "Read the SKILL.md file first if you don't already know its contract, then execute.",
      ];
      await this.routeToSession(ai.id, promptParts.join("\n"), chatId, []);
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
          // Mark sub-agents so the user knows they're about to direct-bind
          // a child session (which is the supported way to take steering of
          // a running sub-agent from a different chat).
          let subPrefix = "";
          {
            const { findByChildAiSession } = await import("../sub-agents/store.js");
            if (findByChildAiSession(ai.id)) subPrefix = "🤖 ";
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
          e.label = `${subPrefix}${tgPrefix}${main} · ${ai.id.slice(0, 4)}`.slice(0, 60);
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
      await this.showBindPreviewChooser(chatId, messageId, aiId);
      return;
    }

    if (data.startsWith("bindcommit:")) {
      // Format: bindcommit:<aiSessionId>:<historyCount>
      const rest = data.slice("bindcommit:".length);
      const sep = rest.lastIndexOf(":");
      if (sep < 0) return;
      const aiId = rest.slice(0, sep);
      const count = parseInt(rest.slice(sep + 1), 10) || 0;
      await this.bindAiSession(chatId, messageId, aiId, { historyCount: count });
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

  // Step 1 of /bind for existing sessions: ask how much prior history to
  // surface in the chat before committing the bind. Lets the user see
  // recent context without having to /export afterward. "None" commits
  // immediately with no preview block.
  private async showBindPreviewChooser(
    chatId: number,
    messageId: number,
    aiId: string,
  ): Promise<void> {
    const s = aiStore.read(aiId);
    if (!s) {
      await this.editTo(chatId, messageId, `Session not found: ${aiId}`);
      return;
    }
    const header =
      `Bind to ${s.id} (${s.provider}${s.name ? ` · ${s.name}` : ""})?\n` +
      `Optionally show recent history first:`;
    await this.editTo(chatId, messageId, header, [
      [
        { text: "None", callback_data: `bindcommit:${aiId}:0` },
        { text: "Last 5", callback_data: `bindcommit:${aiId}:5` },
      ],
      [
        { text: "Last 10", callback_data: `bindcommit:${aiId}:10` },
        { text: "Last 25", callback_data: `bindcommit:${aiId}:25` },
      ],
      [{ text: "← back", callback_data: "nav:exist" }],
    ]);
  }

  private async bindAiSession(
    chatId: number,
    messageId: number,
    aiId: string,
    opts: { historyCount?: number } = {},
  ): Promise<void> {
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

    // Optional history preview — fetch the last N user/assistant messages
    // from the underlying provider session and post them to the chat in a
    // single preview bubble. Best-effort: a sessions with no provider id
    // yet, or a getSession failure, just skips the preview.
    const historyCount = opts.historyCount ?? 0;
    if (historyCount > 0 && s.sessionId && this.api) {
      try {
        const detail = await getProvider(s.provider).getSession(s.sessionId);
        const msgs = detail.messages.slice(-historyCount);
        if (msgs.length > 0) {
          const lines = msgs.map((m) => {
            const role = m.role === "user" ? "👤" : "🤖";
            const text = m.content.replace(/\s+/g, " ").trim().slice(0, 400);
            return `${role} ${text}`;
          });
          const preview = `📜 Last ${msgs.length} message${msgs.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`;
          await this.send({ chatId }, { text: preview });
        }
      } catch (e: any) {
        console.error("[telegram] bind preview failed:", e?.message ?? e);
      }
    }

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
    // /interrupt and /stop are handled in handleSlashCommand and never reach
    // here — both call handle.interrupt() on the live ActiveTurn.
    if (!trimmed && !attachments.length) return;
    const ai = aiStore.read(aiSessionId);
    if (!ai) {
      await this.api.sendMessage({ chat_id: chatId, text: "Session not found." });
      return;
    }

    // If a turn for this AiSession is already in flight, steer the new text
    // into it instead of spawning a parallel query() (which would race on
    // the same provider session and give us mixed tool traces). The user's
    // mental model: "follow-up while the agent is thinking joins the same
    // thought." Attachments mid-turn aren't supported by steer — fall back
    // to a queued turn for those.
    const inFlight = turnsRegistry.getByAiSession(aiSessionId);
    if (inFlight && inFlight.handle?.steer && trimmed && !attachments.length) {
      try {
        await inFlight.handle.steer(trimmed);
        const preview = truncateForPreview(trimmed, 120);
        inFlight.status.push(`✏️ steer: ${preview}`);
        return;
      } catch (e: any) {
        console.error("[telegram] steer failed; falling back to new turn:", e?.message ?? e);
      }
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
    // Register an active turn so PreToolUse/PostToolUse hooks know which
    // status bubble + trace to drive. Hooks are the only source of
    // intermediate UI now — we stop iterating tool/text events from the
    // SDK below and just drain the stream for image events + final output.
    const sentImagePaths = new Set<string>();
    const turn: turnsRegistry.ActiveTurn = {
      aiSessionId: ai.id,
      providerSessionId: ai.sessionId, // backfilled below for new sessions
      chatId,
      threadId: ai.channels?.telegram?.threadId,
      status,
      trace,
      startedAt: trace.startedAt,
      sentImagePaths,
    };
    turnsRegistry.register(turn);
    try {
      const handle = getProvider(ai.provider).run({
        prompt: trimmed || "(see attachments)",
        attachments,
        aiSessionId: ai.id,
        cwd: ai.cwd ?? workspaceDir(),
        yolo: true,
        effort: ai.reasoningEffort ?? resolveProviderEffort(ai.provider),
      });
      // Make the live handle available to follow-up dispatches so they can
      // steer (inject) text into this turn instead of spawning a parallel one.
      turn.handle = handle;
      const live = getLive(handle.meta.runId);
      // Drain the SDK stream for the two things hooks don't carry: the
      // session_id (so we can route PostToolUse hooks for fresh sessions
      // back to this turn) and image events (codex's imageGeneration item
      // isn't a standard hook event). Claude and Codex tool/text UI is
      // hook-driven; opencode still uses provider-stream tool events.
      const drainer = (async () => {
        if (!live) return;
        for await (const ev of live.events) {
          if (ev.type === "session_id") {
            turnsRegistry.bindProviderSession(ai.id, ev.sessionId);
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
          } else if (ai.provider === "opencode" && ev.type === "tool_use") {
            const inputStr = formatToolInput(ev.input);
            status.push(`🔧 ${ev.name}${inputStr ? `: ${inputStr}` : ""}`);
            trace.events.push({ ts: Date.now(), type: "tool_use", name: ev.name, input: ev.input });
          } else if (ai.provider === "opencode" && ev.type === "tool_result") {
            status.markLastDone();
            trace.events.push({ ts: Date.now(), type: "tool_result", name: ev.name, output: ev.output });
          }
          // Claude tool_use/tool_result/text is ignored here; hooks drive
          // that UI. Non-Claude text waits for the final bubble.
        }
      })();

      const meta = await handle.done;
      await drainer; // make sure all session_id / image events flushed
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
      // Don't let a transient send failure (e.g. Telegram 429 after the
      // built-in retries are exhausted) crash the whole route turn — the
      // run already succeeded, we just couldn't post the final bubble.
      try {
        await status.finalize(finalText);
      } catch (e: any) {
        console.error("[telegram] finalize failed:", e?.message ?? e);
      }
      // Activity on this session — record what we sent so /watch status shows
      // the actual most recent bot post (route OR watcher), and slide the
      // watch deadline if a sliding-TTL watch is configured. Default-on
      // logic also lives here: chats whose session has no explicit watch
      // state get auto-enabled with the default TTL on the first response,
      // so users don't have to /watch by hand.
      try {
        const fresh = aiStore.read(ai.id);
        if (fresh) {
          fresh.lastBotMessageAt = new Date().toISOString();
          fresh.lastBotMessagePreview = finalText.slice(0, 240);
          aiStore.write(fresh);
        }
      } catch (e) {
        console.error("[telegram] post-route persist failed:", e);
      }
    } catch (e: any) {
      console.error("[telegram] routeToSession error:", e?.stack ?? e?.message ?? e);
      trace.finalText = `Error: ${e?.message ?? e}`;
      trace.finishedAt = Date.now();
      await status.finalize(`Error: ${e?.message ?? e}`);
    } finally {
      stopTyping();
      turnsRegistry.remove(turn);
    }
  }

  private openStatusBlock(chatId: number) {
    return openStatusBlock(this.api!, chatId, async (text) => {
      await this.send({ chatId }, { text });
    });
  }

  // (Re)publish the bot menu. Called at start and any time something that
  // affects what's advertised changes (e.g. /skills on/off). Best-effort:
  // a Telegram outage shouldn't crash anything.
  async refreshCommandMenu(): Promise<void> {
    const api = this.ensureApi();
    if (!api) return;
    const advertise = getBoolSetting(SKILLS_ADVERTISE_KEY, true);
    const skillCommands = advertise
      ? buildSkillCommands(workspaceDir()).map((s) => ({
          command: s.command,
          description: s.description,
        }))
      : [];
    const merged = [...SLASH_COMMANDS, ...skillCommands];
    try {
      await api.setMyCommands({ commands: merged });
    } catch (e: any) {
      console.error("[telegram] setMyCommands failed:", e?.message ?? e);
    }
  }

  // Public façade used by sub-agents/runner.ts when it needs its own
  // throttled-edit bubble. Same factory as the private route-turn one;
  // exposed here so runners outside this module don't have to know about
  // the api / sendMessage plumbing.
  openSubAgentBubble(chatId: number) {
    return openStatusBlock(this.api!, chatId, async (text) => {
      await this.send({ chatId }, { text });
    });
  }

  // Public photo sender — also routed through the same TelegramApi so the
  // 429 retry / multipart logic applies. Exposed so the sub-agent runner
  // can render image events without importing TelegramApi directly.
  async sendPhotoToChat(opts: {
    chatId: number;
    bytes: Buffer;
    filename: string;
    mimeType?: string;
    threadId?: number;
  }): Promise<void> {
    if (!this.api) return;
    await this.api.sendPhoto({
      chat_id: opts.chatId,
      photo: { bytes: opts.bytes, filename: opts.filename, mimeType: opts.mimeType },
      message_thread_id: opts.threadId,
    });
  }
}

export const telegramChannel = new TelegramChannel();
