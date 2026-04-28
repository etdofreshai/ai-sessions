export interface SessionChannelBindings {
  telegram?: { chatId: number; threadId?: number };
}

export interface AiSession {
  id: string; // UUID
  name: string | null;
  provider: string; // "claude" | "codex" | "opencode"
  // Provider-side session id. Optional because an AiSession can be created
  // up-front (e.g. via the Telegram picker "+ new claude") and only filled
  // in once the first run completes on the provider.
  sessionId?: string;
  // Working directory the provider session was created under. Sticky:
  // resumes always use this cwd because providers (notably claude) scope
  // session storage by directory.
  cwd?: string;
  model?: string;
  channels?: SessionChannelBindings;
  createdAt: string;
  updatedAt: string;
}
