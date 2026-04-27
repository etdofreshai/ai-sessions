export interface AiSession {
  id: string; // UUID
  name: string | null;
  provider: string; // "claude" | "codex" | "opencode"
  sessionId: string; // provider-side session/thread id
  model?: string;
  createdAt: string;
  updatedAt: string;
}
