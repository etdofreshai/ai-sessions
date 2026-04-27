export interface AiSessionProviderLink {
  sessionId: string;
  lastUsedAt: string;
}

export interface AiSession {
  id: string; // UUID
  name: string | null;
  createdAt: string;
  updatedAt: string;
  providers: Partial<Record<string, AiSessionProviderLink>>;
}
