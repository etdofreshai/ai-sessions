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

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  reply_to_message?: TgMessage;
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

  answerCallbackQuery(opts: { callback_query_id: string; text?: string; show_alert?: boolean }) {
    return this.call("answerCallbackQuery", opts);
  }
}
