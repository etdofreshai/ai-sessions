# ai-sessions runtime image.
#
# Bundles the server plus the three agent CLIs (claude, codex, opencode) so
# providers can invoke them out of the box. The SDK npm packages
# (@anthropic-ai/claude-agent-sdk, etc.) come from the project's package.json.
#
# Provider auth state lives in $HOME/.claude, $HOME/.codex,
# $HOME/.local/share/opencode — mount those as volumes from the host if you
# want runs to inherit your local login. The container runs as the non-root
# `node` user (uid 1000), so $HOME is /home/node.

FROM node:22-slim

# Install codex and opencode via npm (claude is installed below via the
# official native installer instead of @anthropic-ai/claude-code, since the
# agent-sdk's bundled platform-specific binary is fragile in cross-libc
# Docker builds).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
        @openai/codex \
        opencode-ai

WORKDIR /app
RUN chown node:node /app

USER node

# Install Claude Code via the official native installer so the agent-sdk
# can be pointed at a real binary. Lands at /home/node/.local/bin/claude.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install project deps first (cache-friendly).
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci

# Copy source and build.
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN npm run build

# Default paths inside the container — override at runtime as needed.
ENV AI_SESSIONS_DATA_DIR=/app/data
ENV AI_SESSIONS_WORKSPACE_DIR=/app/workspace
ENV AI_SESSIONS_PORT=7878
# Point the agent-sdk at the natively-installed claude binary.
ENV CLAUDE_CODE_EXECUTABLE=/home/node/.local/bin/claude

EXPOSE 7878

# Persistence + agent auth state. Mount each from the host if desired:
#   docker run -v $HOME/.claude:/home/node/.claude
#              -v $HOME/.codex:/home/node/.codex
#              -v $HOME/.local/share/opencode:/home/node/.local/share/opencode
#              -v ./.ai-sessions:/app/data
#              -v ./workspace:/app/workspace
#              -p 7878:7878
#              --env-file .env
#              ai-sessions

CMD ["node", "dist/cli.js", "serve"]
