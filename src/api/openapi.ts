export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "ai-sessions API",
    version: "0.1.0",
    description:
      "Local API to call, manage, and view sessions across claude, codex, and opencode. Unified vocabulary: a Session is a persistent thread; a Run is a single prompt → response cycle inside a session. YOLO (bypass permissions/sandbox) is on by default; disable with AI_SESSIONS_YOLO=0 or per-request `yolo: false`.",
  },
  servers: [{ url: "http://localhost:7878" }],
  paths: {
    "/": {
      get: {
        summary: "Index of available endpoints",
        responses: { "200": { description: "JSON index" } },
      },
    },
    "/openapi.json": {
      get: {
        summary: "This OpenAPI document",
        responses: { "200": { description: "OpenAPI 3.1 JSON" } },
      },
    },
    "/providers": {
      get: {
        summary: "List provider availability",
        responses: { "200": { description: "Array of { name, available }" } },
      },
    },
    "/channels": {
      get: {
        summary: "List configured channels and their availability",
        responses: { "200": { description: "Array of { name, available }" } },
      },
    },
    "/providers/{provider}/sessions": {
      get: {
        summary: "List sessions for a provider",
        parameters: [
          {
            name: "provider",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["claude", "codex", "opencode"] },
          },
        ],
        responses: { "200": { description: "Array of SessionSummary" } },
      },
    },
    "/providers/{provider}/sessions/{id}": {
      get: {
        summary: "Get a session's transcript",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "SessionDetail" }, "404": { description: "Not found" } },
      },
    },
    "/providers/{provider}/runs": {
      get: {
        summary: "List recent run ids (from dataDir/runs)",
        responses: { "200": { description: "Array of { runId }" } },
      },
      post: {
        summary: "Start a new run (prompt → response cycle)",
        description:
          "Streams Server-Sent Events by default. Pass `?stream=0` for a sync JSON response, or `?answerOnly=1` for plain-text final output only. To continue an existing session, pass `sessionId`.",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          {
            name: "stream",
            in: "query",
            schema: { type: "string" },
            description: "Set to '0' to disable SSE.",
          },
          {
            name: "answerOnly",
            in: "query",
            schema: { type: "string" },
            description: "Set to '1' for plain-text final-answer-only response.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  sessionId: { type: "string", description: "Provider session id (claude session_id, codex thread_id, etc.)" },
                  aiSessionId: { type: "string", description: "Logical Session id from /sessions; auto-resolves the provider sessionId." },
                  cwd: { type: "string" },
                  yolo: { type: "boolean", description: "Default true." },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "SSE stream of RunEvents (default), or RunMetadata JSON, or plain-text answer.",
          },
        },
      },
    },
    "/providers/{provider}/runs/{runId}": {
      get: {
        summary: "Get a run's metadata (and persisted events if not live)",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "RunMetadata + events (when terminal)" },
          "404": { description: "Not found" },
        },
      },
    },
    "/providers/{provider}/runs/{runId}/interrupt": {
      post: {
        summary: "Interrupt a live run",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "{ ok: true }" },
          "404": { description: "Run not active" },
        },
      },
    },
    "/sessions": {
      get: {
        summary: "List AiSessions (logical, provider-agnostic)",
        responses: { "200": { description: "Array of AiSession" } },
      },
    },
    "/sessions/{id}": {
      get: {
        summary: "Get an AiSession",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "AiSession { id, name, providers: { [providerName]: { sessionId, lastUsedAt } } }" },
          "404": { description: "Not found" },
        },
      },
      patch: {
        summary: "Update AiSession metadata (name only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { type: "object", properties: { name: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "Updated AiSession" } },
      },
      delete: {
        summary: "Delete an AiSession (provider sessions are not affected)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ ok: true }" } },
      },
    },
    "/sessions/{id}/fork": {
      post: {
        summary: "Fork an AiSession onto a different provider, seeded from the source",
        description:
          "By default replays the source transcript verbatim if it fits the target's token budget; otherwise (or with destructive:true) summarizes via the default agent and uses that as the seed.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["targetProvider"],
                properties: {
                  targetProvider: { type: "string", enum: ["claude", "codex", "opencode"] },
                  destructive: { type: "boolean", description: "Force summary even if replay would fit." },
                  cwd: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "{ id, provider, sessionId, seedMode: 'replay'|'summary', estimatedTokens } — the new AiSession.",
          },
        },
      },
    },
    "/providers/{provider}/runs/{runId}/steer": {
      post: {
        summary: "Inject a mid-run user message (Claude only today)",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "runId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["input"],
                properties: { input: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ ok: true }" },
          "404": { description: "Run not active" },
          "501": { description: "Provider does not support steering" },
        },
      },
    },
  },
} as const;
