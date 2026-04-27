export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "ai-sessions API",
    version: "0.1.0",
    description:
      "Local API to call, manage, and view sessions across claude, codex, and opencode. Includes thin wrappers and SDK-mirror endpoints. YOLO (bypass permissions/sandbox) is on by default; disable with AI_SESSIONS_YOLO=0 or per-request `yolo: false`.",
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
    "/providers/{provider}/sessions": {
      get: {
        summary: "List sessions for a provider",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string", enum: ["claude", "codex", "opencode"] } },
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
    "/providers/{provider}/run": {
      post: {
        summary: "Run a prompt against any provider (thin)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string" },
                  sessionId: { type: "string" },
                  cwd: { type: "string" },
                  yolo: { type: "boolean", description: "Default true" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "{ sessionId, output }" } },
      },
    },

    "/claude/query": {
      post: {
        summary: "Mirror of @anthropic-ai/claude-agent-sdk `query({ prompt, options })`",
        description: "Returns the full message array. Pass ?stream=1 for SSE.",
        parameters: [
          { name: "stream", in: "query", schema: { type: "string" }, description: "Set to 1 for SSE" },
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
                  options: {
                    type: "object",
                    additionalProperties: true,
                    description:
                      "Forwarded to claude-agent-sdk. Common keys: cwd, resume, permissionMode ('default'|'acceptEdits'|'plan'|'bypassPermissions'), model, allowedTools.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Array of SDK messages (or SSE stream when ?stream=1)",
          },
        },
      },
    },

    "/codex/threads": {
      post: {
        summary: "Mirror of `codex.startThread(options)` / `codex.resumeThread(id, options)`",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  resumeId: { type: "string", description: "Resume an existing thread by id" },
                  yolo: { type: "boolean" },
                  threadOptions: {
                    type: "object",
                    description:
                      "Codex SDK ThreadOptions. Keys: model, sandboxMode ('read-only'|'workspace-write'|'danger-full-access'), workingDirectory, skipGitRepoCheck, modelReasoningEffort, networkAccessEnabled, webSearchMode, webSearchEnabled, approvalPolicy ('never'|'on-request'|'on-failure'|'untrusted'), additionalDirectories.",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "{ threadId, idAssigned } — `threadId` is a temp UUID until the first run completes; `idAssigned` indicates whether it's the canonical Codex thread id.",
          },
        },
      },
    },
    "/codex/threads/{id}/run": {
      post: {
        summary: "Mirror of `thread.run(input, turnOptions)`",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["input"],
                properties: {
                  input: {
                    description: "Either a string or an array of UserInput ({type:'text'|'local_image', ...}).",
                    oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }],
                  },
                  turnOptions: {
                    type: "object",
                    description: "TurnOptions: only `outputSchema` and `signal` are supported by the SDK.",
                    properties: {
                      outputSchema: { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Turn { items, finalResponse, usage } plus { threadId } for canonical id after first run.",
          },
        },
      },
    },
  },
} as const;
