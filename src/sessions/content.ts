// Two flatteners for claude-shaped message content. They have intentionally
// different semantics — keep them as separate exports rather than one
// boolean-flagged function so the call site reads as the intent.

// Full content: text blocks plus a JSON dump of anything else (tool_use,
// tool_result, thinking, ...). Used by provider transcript readers where
// callers want everything serialized for display/debug.
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : c?.text ?? JSON.stringify(c)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

// Visible-text-only: skips tool_use / tool_result / thinking blocks so chat
// channels mirroring a session aren't spammed with internals. Returns the
// trimmed concatenation, or "" when there's nothing user-facing.
export function flattenVisibleText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content as any[]) {
      if (typeof c === "string") parts.push(c);
      else if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
    return parts.join("\n").trim();
  }
  return "";
}
