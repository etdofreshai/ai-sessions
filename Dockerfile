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
#
# Also install a baseline dev toolchain so agents running inside the
# container can build and run native code without needing to apt-install
# packages mid-task: gcc/g++/make from build-essential, Python 3, and a
# handful of headers commonly required by `pip install` / `cargo build`
# (openssl + pkg-config). Rust is installed in a separate layer below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        build-essential \
        pkg-config \
        libssl-dev \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g \
        @openai/codex \
        opencode-ai

# Rust toolchain via rustup (distro rustc is too old for most modern crates).
# Installs to /usr/local so all users see it; default toolchain is stable.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --default-toolchain stable --profile minimal \
    && chmod -R a+rwX /usr/local/rustup /usr/local/cargo \
    && rustc --version && cargo --version

# Install Claude Code's native binary system-wide. The official install.sh
# would land it under $HOME/.local/bin/claude, but deployments often mount
# host volumes over /home/node which would shadow it at runtime. Place it
# at /usr/local/bin/claude instead — immune to home-dir mounts.
RUN set -eux \
    && CC_VERSION=$(curl -fsSL https://downloads.claude.ai/claude-code-releases/latest) \
    && curl -fsSL "https://downloads.claude.ai/claude-code-releases/$CC_VERSION/linux-x64/claude" \
        -o /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude \
    && /usr/local/bin/claude --version

WORKDIR /app
RUN chown node:node /app

USER node

# Default git identity for any commits the agent makes from inside the
# container (e.g. workspace auto-sync). Override at runtime by mounting a
# host ~/.gitconfig or by `git config --global` inside an interactive shell.
RUN git config --global user.name "ETdoFresh" \
    && git config --global user.email "etdofresh@gmail.com"

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
