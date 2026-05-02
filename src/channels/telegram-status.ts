import type { TelegramApi } from "./telegram-api.js";
import { markdownToTelegramHtml } from "./telegram-format.js";

export interface StatusBlock {
  // Add a discrete bubble line (e.g. a tool trace). Freezes any streaming
  // text segment so the next appendText starts a new line.
  push(line: string): void;
  // Append a chunk to the current streaming-text segment. Token-friendly:
  // call repeatedly as the model streams. Long segments are tail-trimmed.
  appendText(chunk: string): void;
  // Convert the most recent 🔧 line to ✓ — call when a tool resolves.
  markLastDone(): void;
  // Replace the bubble's body with the final response text. Tries HTML
  // first, falls back to plain on parse failure. Long replies overflow
  // into a follow-up plain message via `fallbackSend`.
  finalize(text: string): Promise<void>;
}

// Creates an initial "thinking…" message and returns a controller that
// batches edits (≥1.5s apart by default) so we don't blow telegram's flood
// limit. `fallbackSend` is invoked when the bubble couldn't be created
// initially OR when the final reply overflows 4096 chars — typically the
// channel's own send method.
export async function openStatusBlock(
  api: TelegramApi,
  chatId: number,
  fallbackSend: (text: string) => Promise<void>,
): Promise<StatusBlock> {
  const MIN_INTERVAL = 1500;
  const MAX_LINES = 12;
  const TEXT_LINE_MAX = 800;
  const PLACEHOLDER = "🤔 thinking…";

  const lines: string[] = [PLACEHOLDER];
  // Index of the in-progress "💬 …" text line within `lines`, if any.
  let currentTextIdx: number | null = null;
  let messageId: number | null = null;
  let lastEditAt = 0;
  let pending: NodeJS.Timeout | null = null;

  const render = (): string => lines.join("\n").slice(0, 4000) || PLACEHOLDER;

  try {
    const m = await api.sendMessage({ chat_id: chatId, text: render() });
    messageId = m.message_id;
    lastEditAt = Date.now();
  } catch {
    /* best-effort — fallbackSend handles the no-bubble case in finalize */
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
      /* "not modified" / rate limit — already handled by callRaw retry */
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

  const dropPlaceholder = (): void => {
    if (lines.length === 1 && lines[0] === PLACEHOLDER) lines.length = 0;
  };

  const trimLines = (): void => {
    if (lines.length <= MAX_LINES) return;
    const dropCount = lines.length - MAX_LINES;
    // Pin line 0 as a header once any caller has pushed real content. The
    // placeholder is the only line we'd ever drop from the top; after the
    // first push() runs dropPlaceholder, lines[0] is the bubble's header
    // (e.g. "🤖 sub-agent abc12345 (label) · codex") and should stay
    // visible even as older tool lines age out.
    const startIdx = lines[0] === PLACEHOLDER ? 0 : 1;
    lines.splice(startIdx, dropCount);
    if (currentTextIdx != null) {
      currentTextIdx -= dropCount;
      if (currentTextIdx < startIdx) currentTextIdx = null;
    }
  };

  return {
    push(line: string) {
      dropPlaceholder();
      // Any non-text line ends the current streaming text block, so the
      // next text chunk starts in its own bubble line.
      currentTextIdx = null;
      lines.push(line);
      trimLines();
      schedule();
    },
    appendText(chunk: string) {
      if (!chunk) return;
      dropPlaceholder();
      if (currentTextIdx == null) {
        lines.push(`💬 ${chunk}`);
        currentTextIdx = lines.length - 1;
      } else {
        let cur = lines[currentTextIdx] + chunk;
        // Keep the live preview compact — long replies still appear in full
        // when finalize() swaps in the final response.
        if (cur.length > TEXT_LINE_MAX + 2) {
          cur = "💬 …" + cur.slice(-TEXT_LINE_MAX);
        }
        lines[currentTextIdx] = cur;
      }
      trimLines();
      schedule();
    },
    markLastDone() {
      const last = lines[lines.length - 1];
      if (last && last.startsWith("🔧 ")) {
        lines[lines.length - 1] = last.replace(/^🔧/, "✓");
      }
      schedule();
    },
    async finalize(text: string) {
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
      if (messageId == null) {
        await fallbackSend(text);
        return;
      }
      const head = text.slice(0, 4096);
      try {
        await api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: markdownToTelegramHtml(head),
          parse_mode: "HTML",
        });
      } catch {
        try {
          // HTML rejected → retry plain.
          await api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: head,
          });
        } catch {
          /* ignore — caller's outer try/catch will log */
        }
      }
      if (text.length > 4096) {
        await fallbackSend(text.slice(4096));
      }
    },
  };
}
