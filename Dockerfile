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
RUN chown node:node /app

USER node

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
# Point the agent-sdk at the globally-installed claude CLI so it doesn't
# need its bundled platform-specific native binary (which can be skipped by
# `npm ci` when the lockfile was generated on a different libc host).
ENV CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude

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
