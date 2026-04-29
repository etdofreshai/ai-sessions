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

  private async call<T = any>(method: string, body?: object): Promise<T> {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json();
    if (!json.ok) {
      throw new Error(`telegram ${method} failed: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.result as T;
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

  async sendPhoto(opts: {
    chat_id: number;
    photo: { bytes: Buffer; filename: string; mimeType?: string };
    caption?: string;
    message_thread_id?: number;
  }): Promise<TgMessage> {
    const fd = new FormData();
    fd.set("chat_id", String(opts.chat_id));
    if (opts.caption) fd.set("caption", opts.caption);
    if (opts.message_thread_id != null) {
      fd.set("message_thread_id", String(opts.message_thread_id));
    }
    const blob = new Blob([new Uint8Array(opts.photo.bytes)], {
      type: opts.photo.mimeType ?? "image/png",
    });
    fd.set("photo", blob, opts.photo.filename);
    const res = await fetch(`${API_BASE}/bot${this.token}/sendPhoto`, {
      method: "POST",
      body: fd,
    });
    const json: any = await res.json();
    if (!json.ok) {
      throw new Error(`telegram sendPhoto failed: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.result as TgMessage;
  }

  async sendDocument(opts: {
    chat_id: number;
    file: { bytes: Buffer; filename: string; mimeType?: string };
    caption?: string;
    message_thread_id?: number;
  }): Promise<TgMessage> {
    const fd = new FormData();
    fd.set("chat_id", String(opts.chat_id));
    if (opts.caption) fd.set("caption", opts.caption);
    if (opts.message_thread_id != null) {
      fd.set("message_thread_id", String(opts.message_thread_id));
    }
    const blob = new Blob([new Uint8Array(opts.file.bytes)], {
      type: opts.file.mimeType ?? "application/octet-stream",
    });
    fd.set("document", blob, opts.file.filename);
    const res = await fetch(`${API_BASE}/bot${this.token}/sendDocument`, {
      method: "POST",
      body: fd,
    });
    const json: any = await res.json();
    if (!json.ok) {
      throw new Error(`telegram sendDocument failed: ${json.description ?? JSON.stringify(json)}`);
    }
    return json.result as TgMessage;
  }

  sendChatAction(opts: {
    chat_id: number;
    action: "typing" | "upload_photo" | "record_video" | "upload_video" | "record_voice" | "upload_voice" | "upload_document" | "find_location" | "record_video_note" | "upload_video_note";
    message_thread_id?: number;
  }) {
    return this.call("sendChatAction", opts);
  }
}
