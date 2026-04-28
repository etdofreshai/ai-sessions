# ai-sessions runtime image.
#
# Bundles the server plus the three agent CLIs (claude, codex, opencode) so
# providers can invoke them out of the box. The SDK npm packages
# (@anthropic-ai/claude-agent-sdk, etc.) come from the project's package.json.
#
# Provider auth state lives in $HOME/.claude, $HOME/.codex,
# $HOME/.local/share/opencode — mount those as volumes from the host if you
# want runs to inherit your local login.

FROM node:22-slim

# Install the three agent CLIs globally. opencode-ai is the npm publication of
# https://github.com/sst/opencode. claude-code provides `claude`; @openai/codex
# provides `codex`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
        @anthropic-ai/claude-code \
        @openai/codex \
        opencode-ai

WORKDIR /app

# Install project deps first (cache-friendly).
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Default paths inside the container — override at runtime as needed.
ENV AI_SESSIONS_DATA_DIR=/app/data
ENV AI_SESSIONS_WORKSPACE_DIR=/app/workspace
ENV AI_SESSIONS_PORT=7878

EXPOSE 7878

# Persistence + agent auth state. Mount each from the host if desired:
#   docker run -v $HOME/.claude:/root/.claude
#              -v $HOME/.codex:/root/.codex
#              -v $HOME/.local/share/opencode:/root/.local/share/opencode
#              -v ./.ai-sessions:/app/data
#              -v ./workspace:/app/workspace
#              -p 7878:7878
#              --env-file .env
#              ai-sessions
VOLUME ["/app/data", "/app/workspace", "/root/.claude", "/root/.codex", "/root/.local/share/opencode"]

CMD ["node", "dist/cli.js", "serve"]
