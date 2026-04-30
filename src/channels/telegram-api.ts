// Minimal Telegram Bot API client over HTTPS. No SDK dep.
// https://core.telegram.org/bots/api

const API_BASE = "https://api.telegram.org";

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  is_forum?: boolean;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
}

export interface TgVoice extends TgFile {
  duration: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TgPhotoSize[];
  document?: TgFile;
  voice?: TgVoice;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  reply_to_message?: TgMessage;
  // Service messages emitted when a basic group migrates to a supergroup.
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export class TelegramApi {
  constructor(private token: string) {}

  // Honor Telegram's flood-control. A 429 response carries
  // parameters.retry_after (seconds) in the body and Retry-After in the
  // header. We sleep for that long and retry; ≤2 retries so a wedged
  // endpoint can't hold a route turn open indefinitely. Both JSON and
  // multipart endpoints share this loop via callRaw().
  private async callRaw<T>(
    method: string,
    buildInit: () => RequestInit,
  ): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, buildInit());
      const json: any = await res.json();
      if (json.ok) return json.result as T;
      const retryAfter =
        Number(json?.parameters?.retry_after) ||
        Number(res.headers.get("retry-after")) ||
        0;
      if (res.status === 429 && retryAfter > 0 && attempt < 2) {
        attempt++;
        // Cap a single sleep at 60s so we don't pin the route turn forever.
        const delayMs = Math.min(retryAfter, 60) * 1000 + 250;
        console.error(
          `[telegram] 429 on ${method}; retrying in ${delayMs}ms (attempt ${attempt})`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw new Error(`telegram ${method} failed: ${json.description ?? JSON.stringify(json)}`);
    }
  }

  private call<T = any>(method: string, body?: object): Promise<T> {
    return this.callRaw<T>(method, () => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }));
  }

  getMe() {
    return this.call<TgUser>("getMe");
  }

  // For groups returns { title }, for private chats { first_name, username }.
  getChat(chat_id: number) {
    return this.call<TgChat & { first_name?: string; username?: string }>("getChat", {
      chat_id,
    });
  }

  // Two-step download: getFile returns metadata with file_path; the file is
  // then fetched from /file/bot<TOKEN>/<file_path>.
  getFile(file_id: string) {
    return this.call<{ file_id: string; file_size?: number; file_path: string }>(
      "getFile",
      { file_id }
    );
  }

  fileUrl(file_path: string): string {
    return `${API_BASE}/file/bot${this.token}/${file_path}`;
  }

  getUpdates(opts: { offset?: number; timeout?: number; allowed_updates?: string[] }) {
    return this.call<TgUpdate[]>("getUpdates", opts);
  }

  sendMessage(opts: {
    chat_id: number;
    text: string;
    message_thread_id?: number;
    reply_markup?: InlineKeyboardMarkup;
    parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
    disable_notification?: boolean;
  }) {
    return this.call<TgMessage>("sendMessage", opts);
  }

  editMessageText(opts: {
    chat_id: number;
    message_id: number;
    text: string;
    reply_markup?: InlineKeyboardMarkup;
    parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  }) {
    return this.call("editMessageText", opts);
  }

  deleteMessage(opts: { chat_id: number; message_id: number }) {
    return this.call("deleteMessage", opts);
  }

  answerCallbackQuery(opts: { callback_query_id: string; text?: string; show_alert?: boolean }) {
    return this.call("answerCallbackQuery", opts);
  }

  // Telegram shows the indicator for ~5s then auto-clears; resend every <5s
  // to keep it visible during long-running operations.
  setMyCommands(opts: {
    commands: { command: string; description: string }[];
    scope?: { type: "default" | "all_private_chats" | "all_group_chats" | "all_chat_administrators" };
  }) {
    return this.call("setMyCommands", opts);
  }

  // Multipart upload helper — shared between sendPhoto / sendDocument so
  // they both go through callRaw()'s 429 retry loop.
  private async uploadFile(
    method: "sendPhoto" | "sendDocument",
    opts: {
      chat_id: number;
      filePartName: "photo" | "document";
      file: { bytes: Buffer; filename: string; mimeType?: string };
      defaultMimeType: string;
      caption?: string;
      message_thread_id?: number;
    },
  ): Promise<TgMessage> {
    return this.callRaw<TgMessage>(method, () => {
      const fd = new FormData();
      fd.set("chat_id", String(opts.chat_id));
      if (opts.caption) fd.set("caption", opts.caption);
      if (opts.message_thread_id != null) {
        fd.set("message_thread_id", String(opts.message_thread_id));
      }
      const blob = new Blob([new Uint8Array(opts.file.bytes)], {
        type: opts.file.mimeType ?? opts.defaultMimeType,
      });
      fd.set(opts.filePartName, blob, opts.file.filename);
      return { method: "POST", body: fd };
    });
  }

  sendPhoto(opts: {
    chat_id: number;
    photo: { bytes: Buffer; filename: string; mimeType?: string };
    caption?: string;
    message_thread_id?: number;
  }): Promise<TgMessage> {
    return this.uploadFile("sendPhoto", {
      chat_id: opts.chat_id,
      filePartName: "photo",
      file: opts.photo,
      defaultMimeType: "image/png",
      caption: opts.caption,
      message_thread_id: opts.message_thread_id,
    });
  }

  sendDocument(opts: {
    chat_id: number;
    file: { bytes: Buffer; filename: string; mimeType?: string };
    caption?: string;
    message_thread_id?: number;
  }): Promise<TgMessage> {
    return this.uploadFile("sendDocument", {
      chat_id: opts.chat_id,
      filePartName: "document",
      file: opts.file,
      defaultMimeType: "application/octet-stream",
      caption: opts.caption,
      message_thread_id: opts.message_thread_id,
    });
  }

  sendChatAction(opts: {
    chat_id: number;
    action: "typing" | "upload_photo" | "record_video" | "upload_video" | "record_voice" | "upload_voice" | "upload_document" | "find_location" | "record_video_note" | "upload_video_note";
    message_thread_id?: number;
  }) {
    return this.call("sendChatAction", opts);
  }
}
